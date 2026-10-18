import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { hostChannelStatus } from '../broker/host-channels.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { BrokerClient } from '../client/broker-client.js'
import { drainInbox } from '../inbox-spool/drain.js'
import { logPath } from '../paths.js'
import type { ClientMessage, DeliveredMessage, ServerMessage } from '../protocol.js'
import { inboxSpoolDir, spoolRecord, type SpoolRecord } from '../server/inbox-spool.js'
import { ToolHandler } from '../server/tools.js'

/**
 * CC-1455 S5: a print-mode host whose server spools pushes is told `queued`, its hook
 * leaves an `inbox_shown` receipt, and chat_inbox clears what it already returned.
 * Every name and id is synthetic.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const HEADLESS = 'claude -p --output-format stream-json --verbose --channels plugin:agent-chat@local'
const INTERACTIVE = 'claude --channels plugin:agent-chat@local'
const AGENT = 'agent-x'

type SendResult = Extract<ServerMessage, { t: 'send_result' }>
interface Joined {
  conn: Conn
  frames: ServerMessage[]
}

let dir: string
let core: BrokerCore
let server: SocketServer
const argvByPid = new Map<number, string>()

function join(name: string, argv: string, inboxSpool = false): Joined {
  const hostPid = 1000 + argvByPid.size
  argvByPid.set(hostPid, argv)
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  server.handleMessage(conn, {
    t: 'register',
    name,
    workingOn: 'testing',
    cwd: '/tmp',
    pid: 1,
    hostPid,
    ...(inboxSpool ? { inboxSpool: true as const } : {}),
  })
  return { conn, frames }
}

function send(from: Joined, to: string | string[]): SendResult {
  server.handleMessage(from.conn, { t: 'send', to, text: 'stand down' })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const routeRow = (msgId: string | undefined): Record<string, unknown> | undefined =>
  fs
    .readFileSync(logPath(), 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .find(row => row.event === 'route' && row.msgId === msgId)

const direct = (msgId: string): SpoolRecord => ({
  kind: 'message',
  msgId,
  meta: { from: 'impl', msg_id: msgId },
  text: `note ${msgId}`,
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-inbox-queued-'))
  vi.stubEnv('AGENT_CHAT_HOME', dir)
  argvByPid.clear()
  const registry = new Registry<Conn>(Date.now, pid =>
    hostChannelStatus(pid, 'agent-chat', p => argvByPid.get(p)),
  )
  core = new BrokerCore(() => undefined, { events: new EventLog(path.join(dir, 'events.db')), registry })
  server = new SocketServer(core)
})

afterEach(() => {
  server.close()
  core.close()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a send to a print-mode host', () => {
  it.each([
    { spools: true, status: 'queued', row: { delivered: false, queued: ['scout'] } },
    {
      spools: false,
      status: 'headless_no_channel',
      row: { delivered: false, reason: 'headless_no_channel' },
    },
  ])('reads $status when inboxSpool is $spools', ({ spools, status, row }) => {
    // Arrange
    const coord = join('coord', INTERACTIVE)
    join('scout', HEADLESS, spools)

    // Act
    const result = send(coord, 'scout')

    // Assert
    expect(result.ok).toBe(true)
    expect(result.results).toEqual([expect.objectContaining({ name: 'scout', status })])
    expect(routeRow(result.msgId)).toMatchObject(row)
  })

  it('names the spooling recipient of a multicast queued and keeps the interactive one delivered', () => {
    // Arrange
    const coord = join('coord', INTERACTIVE)
    join('seat-a', INTERACTIVE)
    join('scout', HEADLESS, true)

    // Act
    const result = send(coord, ['seat-a', 'scout'])

    // Assert
    expect(result.results).toEqual([
      { name: 'seat-a', status: 'delivered' },
      expect.objectContaining({ name: 'scout', status: 'queued' }),
    ])
    expect(routeRow(result.msgId)).toMatchObject({ delivered: true, queued: ['scout'] })
  })
})

const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text

describe('chat_send wording for a queued recipient', () => {
  it('says the message is queued for its next tool call, not delivered', async () => {
    // Arrange
    const broker = {
      request: async (_: ClientMessage) => ({
        t: 'send_result',
        ok: true,
        msgId: 'm1',
        recipients: ['scout'],
        results: [{ name: 'scout', status: 'queued' }],
      }),
    } as unknown as BrokerClient
    const handler = new ToolHandler(broker, 'coord')

    // Act
    const text = textOf(await handler.handle('chat_send', { to: 'scout', text: 'stand down' }))

    // Assert
    expect(text).toMatch(/queued for "scout"'s next tool call \(msg_id m1\)/)
    expect(text).not.toMatch(/Delivered|NOT SEEN/)
  })
})

describe('the inbox_shown receipt', () => {
  const runHook = (): string => {
    const run = spawnSync(process.execPath, [CLI, 'inbox-hook', AGENT, 'post'], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'sess-1' }),
      env: { ...process.env, AGENT_CHAT_HOME: dir, AGENT_CHAT_NAME: 'impl' },
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    return run.stdout
  }
  const shownRows = () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    try {
      return log
        .ledgerHandle()
        .prepare("SELECT actor, ref, meta FROM events WHERE kind = 'inbox_shown'")
        .all() as { actor: string; ref: string; meta: string }[]
    } finally {
      log.close()
    }
  }

  it('writes one row listing the shown msgIds for a drain, and none for an empty one', () => {
    // Arrange
    expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)
    const spool = inboxSpoolDir(AGENT)
    spoolRecord(spool, direct('m-1'))
    spoolRecord(spool, direct('m-2'))

    // Act
    const shown = runHook()
    const empty = runHook()

    // Assert
    expect(shown).toContain('msg_id=\\"m-1\\"')
    expect(empty).toBe('')
    const rows = shownRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'impl', ref: 'sess-1' })
    expect(JSON.parse(rows[0]!.meta)).toEqual({ msgIds: 'm-1,m-2' })
  })
})

describe('chat_inbox on a spooling session', () => {
  it('clears the spool of what it returned, so the next drain does not show it again', async () => {
    // Arrange
    const spool = inboxSpoolDir(AGENT)
    spoolRecord(spool, direct('m-1'))
    spoolRecord(spool, direct('m-2'))
    const returned: DeliveredMessage = { msgId: 'm-1', from: 'impl', text: 'note m-1', at: 1 }
    const broker = {
      request: async (_: ClientMessage) => ({ t: 'inbox_result', messages: [returned] }),
    } as unknown as BrokerClient
    const handler = new ToolHandler(broker, AGENT, undefined, undefined, spool)

    // Act
    const text = textOf(await handler.handle('chat_inbox', {}))
    const drained = drainInbox(spool)

    // Assert
    expect(text).toContain('[m-1]')
    expect(drained.msgIds).toEqual(['m-2'])
  })
})
