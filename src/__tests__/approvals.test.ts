import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { EventLog, APPROVAL_TTL_MS } from '../broker/event-log.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { Registry } from '../broker/registry.js'
import type { ServerMessage } from '../protocol.js'
import { reapBroker } from './broker-harness.js'

/**
 * Permission relay. Drives the real notification Claude Code sends when a
 * tool-approval dialog opens, asserts we surface it, and asserts that the ONE
 * caller who can answer it is the human at the CLI (CC-96).
 */

const execFileAsync = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-appr-'))

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
})

/** What Claude Code's host listens for. Field names are the host's, not ours. */
const PermissionVerdict = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
})

let transport: StdioClientTransport
let client: Client
const inbox: unknown[] = []
const verdicts: { request_id: string; behavior: string }[] = []

const cli = (args: string[]) =>
  execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME } })

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0]?.text ?? ''
}

/** Impersonates Claude Code opening a permission dialog in this session. */
const openDialog = (params: Record<string, string>) =>
  client.notification({ method: 'notifications/claude/channel/permission_request', params })

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 250))

/**
 * The queue id of the APPR row whose printed body contains `marker`.
 *
 * Matched on the body rather than on position because several prompts are open
 * at once by this point in the file, and the id is what a human would copy off
 * the very line they just read.
 */
function approvalIdFor(stdout: string, marker: string): string {
  let current = ''
  for (const line of stdout.split('\n')) {
    const header = /^APPR\s+(\S+)/.exec(line)
    if (header) current = header[1]!
    else if (current && line.includes(marker)) return current
  }
  throw new Error('no APPR row carried the marker')
}

beforeAll(async () => {
  expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
  })
  client = new Client({ name: 'test-worker', version: '0.0.1' }, { capabilities: {} })
  client.setNotificationHandler(ChannelNotification, n => void inbox.push(n.params))
  client.setNotificationHandler(PermissionVerdict, n => void verdicts.push(n.params))
  await client.connect(transport)
  await call('chat_register', { name: 'worker', working_on: 'a migration' })
}, 30000)

afterAll(async () => {
  await transport.close().catch(() => undefined)
  // See routing.test.ts: the broker is detached and outlives the transport.
  await reapBroker(TEST_HOME)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('capability', () => {
  it('declares permission relay so Claude Code forwards prompts', () => {
    expect(client.getServerCapabilities()?.experimental).toHaveProperty('claude/channel/permission')
  })
})

describe('observing a permission prompt', () => {
  it('surfaces the pending prompt in the human queue', async () => {
    await openDialog({
      request_id: 'qxrtm',
      tool_name: 'Bash',
      description: 'Run shell command',
      input_preview: 'rm -rf build/',
    })
    await settle()

    const { stdout } = await cli(['inbox'])
    expect(stdout).toContain('APPR')
    expect(stdout).toContain('Bash: Run shell command')
    // The description is frequently useless, so the preview must be shown.
    expect(stdout).toContain('rm -rf build/')
    expect(stdout).toContain('worker blocked on a permission prompt')
  })

  it('sends nothing back until a human answers', async () => {
    // A verdict would arrive as a notification to the client; nothing should,
    // because nobody has typed `agent-chat approve` yet.
    expect(inbox).toHaveLength(0)
    expect(verdicts).toHaveLength(0)
  })

  it('marks the session blocked, which chat_list reports', async () => {
    const { stdout } = await cli(['ps'])
    expect(stdout).toContain('blocked')
  })

  it('clears blocked when the session next does anything', async () => {
    // A session waiting on a dialog cannot call tools, so any call proves it closed.
    await call('chat_status', { status: 'working', working_on: 'a migration' })
    await settle()

    const { stdout } = await cli(['ps'])
    expect(stdout).toContain('working')
    expect(stdout).not.toContain('blocked')
  })

  it('keeps the prompt in the log even after the session unblocks', async () => {
    const { stdout } = await cli(['history', '50'])
    expect(stdout).toContain('approval_request')
  })
})

/**
 * CC-96. The verb exists so a blocked agent can be unblocked by the human who
 * is already reading the queue, rather than only at that agent's own terminal.
 * Both halves are asserted: it works from the CLI, and it is unreachable from
 * anything that registered a name.
 */
describe('answering a prompt from the CLI', () => {
  /** Long enough that any truncation shows up, and unique enough to find the row. */
  const preview = `psql -c "${'select 1; '.repeat(40)}"`
  let msgId = ''

  it('prints the whole input preview, so the human decides on what they read', async () => {
    await openDialog({
      request_id: 'v7k2p',
      tool_name: 'Bash',
      description: 'Run shell command',
      input_preview: preview,
    })
    await settle()

    const { stdout } = await cli(['inbox'])
    expect(stdout).toContain(preview)
    expect(stdout).toContain('agent-chat approve <id> allow|deny')
    msgId = approvalIdFor(stdout, preview)
  })

  it('relays the verdict to the session whose dialog is open', async () => {
    const { stdout } = await cli(['approve', msgId, 'allow'])
    expect(stdout).toContain('Sent allow')
    await settle()

    expect(verdicts).toEqual([{ request_id: 'v7k2p', behavior: 'allow' }])
  })

  it('closes the item, so one approval cannot be replayed', async () => {
    await expect(cli(['approve', msgId, 'allow'])).rejects.toThrow(/not an open permission prompt/)
    expect(verdicts).toHaveLength(1)
  })

  it('refuses a verdict that is neither allow nor deny', async () => {
    await expect(cli(['approve', msgId, 'maybe'])).rejects.toThrow(/allow\|deny/)
  })
})

/**
 * The guard is the point of CC-96, so it is tested at the frame rather than
 * through the CLI: the CLI cannot produce a registered connection, and a
 * registered connection is exactly the attacker being excluded — an agent using
 * the session it legitimately holds to grant itself, or a peer, a tool call.
 * See `isHuman` in socket.ts for what this does and does not stop.
 */
describe('who may answer a permission prompt', () => {
  interface Wire {
    conn: Conn
    frames: ServerMessage[]
  }

  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  function makeServer(): { core: BrokerCore; server: SocketServer; wire: () => Wire } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-approve-'))
    dirs.push(dir)
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(dir, 'events.db')),
      registry: new Registry<Conn>(),
    })
    const server = new SocketServer(core)
    const wire = (): Wire => {
      const frames: ServerMessage[] = []
      const conn = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn
      return { conn, frames }
    }
    return { core, server, wire }
  }

  /** A session registered under `name`, blocked on a prompt of its own. */
  function blockedSession(server: SocketServer, wire: () => Wire, name: string): Wire {
    const session = wire()
    server.handleMessage(session.conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1 })
    server.handleMessage(session.conn, {
      t: 'approval',
      requestId: `${name}-req`,
      toolName: 'Bash',
      description: 'Run shell command',
      inputPreview: 'rm -rf build/',
    })
    return session
  }

  const openId = (core: BrokerCore): string =>
    core.events.humanQueue().find(i => i.kind === 'approval_request')!.msgId

  const sentVerdicts = (frames: ServerMessage[]): Extract<ServerMessage, { t: 'permission_verdict' }>[] =>
    frames.filter(
      (f): f is Extract<ServerMessage, { t: 'permission_verdict' }> => f.t === 'permission_verdict',
    )

  it('refuses a verdict from a registered session, so no agent can answer a prompt', () => {
    const { core, server, wire } = makeServer()
    const worker = blockedSession(server, wire, 'worker')
    const peer = wire()
    server.handleMessage(peer.conn, {
      t: 'register',
      name: 'peer',
      workingOn: 'testing',
      cwd: '/tmp',
      pid: 1,
    })
    const msgId = openId(core)

    // Its own prompt, and then a peer's: neither is a session's call.
    server.handleMessage(worker.conn, { t: 'approve_permission', msgId, behavior: 'allow' })
    server.handleMessage(peer.conn, { t: 'approve_permission', msgId, behavior: 'allow' })

    expect(sentVerdicts(worker.frames)).toHaveLength(0)
    for (const frames of [worker.frames, peer.frames]) {
      const refusal = frames.at(-1) as Extract<ServerMessage, { t: 'answer_result' }>
      expect(refusal.ok).toBe(false)
      expect(refusal.reason).toMatch(/human’s call/)
    }
    // Still open: a refused verdict must not close the item behind the human.
    expect(core.events.humanQueue().some(i => i.msgId === msgId)).toBe(true)
  })

  it('records a session reaching for it, rather than refusing silently', () => {
    const { core, server, wire } = makeServer()
    const worker = blockedSession(server, wire, 'worker')
    server.handleMessage(worker.conn, {
      t: 'approve_permission',
      msgId: openId(core),
      behavior: 'allow',
    })

    const refused = core.events.history(50).filter(i => i.kind === 'verdict_refused')
    expect(refused.at(-1)?.text).toMatch(/answer a permission prompt/)
  })

  it('sends the verdict when the same frame comes from an unregistered connection', () => {
    const { core, server, wire } = makeServer()
    const worker = blockedSession(server, wire, 'worker')
    const human = wire()

    server.handleMessage(human.conn, { t: 'approve_permission', msgId: openId(core), behavior: 'deny' })

    expect(sentVerdicts(worker.frames)).toEqual([
      { t: 'permission_verdict', requestId: 'worker-req', behavior: 'deny' },
    ])
    expect(core.events.humanQueue().filter(i => i.kind === 'approval_request')).toHaveLength(0)
  })

  it('refuses when the prompting session has gone, since its request id died with it', () => {
    const { core, server, wire } = makeServer()
    const worker = blockedSession(server, wire, 'worker')
    const human = wire()
    const msgId = openId(core)
    core.drop(worker.conn)

    server.handleMessage(human.conn, { t: 'approve_permission', msgId, behavior: 'allow' })

    const refusal = human.frames.at(-1) as Extract<ServerMessage, { t: 'answer_result' }>
    expect(refusal.ok).toBe(false)
    expect(refusal.reason).toMatch(/no longer connected/)
    expect(sentVerdicts(worker.frames)).toHaveLength(0)
  })

  it('refuses a prompt that has aged out, matching what the queue will show', () => {
    const { core, server, wire } = makeServer()
    blockedSession(server, wire, 'worker')
    const human = wire()
    const msgId = openId(core)

    const log = core.events as unknown as { db: { exec: (sql: string) => void } }
    log.db.exec(`UPDATE events SET ts = ts - ${APPROVAL_TTL_MS + 1000} WHERE kind = 'approval_request'`)
    server.handleMessage(human.conn, { t: 'approve_permission', msgId, behavior: 'allow' })

    const refusal = human.frames.at(-1) as Extract<ServerMessage, { t: 'answer_result' }>
    expect(refusal.ok).toBe(false)
    expect(refusal.reason).toMatch(/aged out/)
  })
})

describe('stale approvals', () => {
  it('drops a pending approval from the queue once it ages out', () => {
    // Claude Code sends no event when the local dialog wins, so an unanswered
    // approval must be presumed resolved rather than lingering forever.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ttl-'))
    const log = new EventLog(path.join(dir, 'events.db'))

    log.append({ kind: 'approval_request', actor: 'worker', target: 'human', body: 'Bash: old one' })
    expect(log.humanQueue()).toHaveLength(1)

    const db = log as unknown as { db: { exec: (sql: string) => void } }
    db.db.exec(`UPDATE events SET ts = ts - ${APPROVAL_TTL_MS + 1000} WHERE kind = 'approval_request'`)

    expect(log.humanQueue()).toHaveLength(0)
    log.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not age out questions, which stay until answered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ttl-'))
    const log = new EventLog(path.join(dir, 'events.db'))

    log.append({ kind: 'question', actor: 'worker', target: 'human', body: 'still relevant?' })
    const db = log as unknown as { db: { exec: (sql: string) => void } }
    db.db.exec(`UPDATE events SET ts = ts - ${APPROVAL_TTL_MS * 10}`)

    expect(log.humanQueue()).toHaveLength(1)
    log.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
