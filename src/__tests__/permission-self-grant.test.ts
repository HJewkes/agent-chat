import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { recordSelfGrant } from '../cli/verbs/permission-hook.js'

/**
 * CC-694 slice d: every call the permission hook allows itself leaves an audit row,
 * an `approval_request` of source self-grant closed at once by an `allow` resolution.
 */

interface Wire {
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
}

const dirs: string[] = []
const savedHome = process.env.AGENT_CHAT_HOME

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = savedHome
  vi.restoreAllMocks()
})

afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sg-'))
  dirs.push(dir)
  return dir
}

function setup(): { core: BrokerCore; server: SocketServer; wire: () => Wire } {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(tmpDir(), 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  const wire = (): Wire => {
    const frames: ServerMessage[] = []
    const emitter = new EventEmitter()
    const conn = Object.assign(emitter, {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    }) as unknown as Conn
    server.onConnection(conn)
    return { frames, send: msg => emitter.emit('data', JSON.stringify(msg) + '\n') }
  }
  return { core, server, wire }
}

const SKILL_WRITE = { file_path: '/w/.claude/skills/probe/SKILL.md', content: 'x' }

const GRANT: ClientMessage = {
  t: 'permission_self_granted',
  session: 'scout',
  toolName: 'Write',
  toolInput: SKILL_WRITE,
  grant: 'repo-skills',
}

const rows = (core: BrokerCore) => core.events.since(0, 1000)

describe('a self-grant record from the hook', () => {
  it('appends an approval_request of source self-grant closed by an allow resolution', () => {
    const { core, wire } = setup()
    const hook = wire()

    hook.send(GRANT)

    const result = hook.frames.at(-1)
    expect(result).toMatchObject({ t: 'permission_hook_result', ok: true })
    const msgId = result?.t === 'permission_hook_result' ? result.msgId : undefined
    const request = rows(core).find(row => row.msgId === msgId)
    expect(request).toMatchObject({ kind: 'approval_request', actor: 'scout' })
    expect(request?.meta).toMatchObject({ source: 'self-grant', grant: 'repo-skills', tool_name: 'Write' })
    expect(JSON.parse(String(request?.meta?.input_preview))).toEqual(SKILL_WRITE)
    const resolution = rows(core).find(row => row.kind === 'resolution' && row.ref === msgId)
    expect(resolution).toMatchObject({ body: 'allow', actor: 'scout' })
    expect(resolution?.meta).toMatchObject({ reason: 'self-grant: repo-skills' })
  })

  it('never reaches the human queue, since nobody is waiting on it', () => {
    const { core, wire } = setup()

    wire().send(GRANT)

    expect(core.events.humanQueue()).toHaveLength(0)
  })

  it('is refused from a registered session, which cannot vouch for its own grants', () => {
    const { core, wire } = setup()
    const peer = wire()
    peer.send({ t: 'register', name: 'peer', workingOn: 'testing', cwd: '/tmp', pid: 1 })

    peer.send(GRANT)

    expect(peer.frames.at(-1)).toMatchObject({ t: 'permission_hook_result', ok: false })
    expect(rows(core).some(row => row.kind === 'approval_request')).toBe(false)
  })
})

describe('recordSelfGrant', () => {
  const input = { sessionId: 'f91c0f3a-4584', toolName: 'Write', toolInput: SKILL_WRITE }

  it('lands the audit row through a live socket under the spawn name', async () => {
    const { core, server } = setup()
    const home = tmpDir()
    const listener = net.createServer(socket => server.onConnection(socket as unknown as Conn))
    await new Promise<void>(resolve => listener.listen(path.join(home, 'chat.sock'), resolve))
    process.env.AGENT_CHAT_HOME = home

    try {
      await recordSelfGrant(input, { AGENT_CHAT_NAME: 'scout' })
    } finally {
      listener.close()
    }

    const request = rows(core).find(row => row.kind === 'approval_request')
    expect(request).toMatchObject({ actor: 'scout' })
    expect(request?.meta).toMatchObject({ source: 'self-grant' })
  })

  it('gives up within its cap and only logs when no broker answers', async () => {
    process.env.AGENT_CHAT_HOME = tmpDir()
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const started = Date.now()

    await recordSelfGrant(input, {}, 300)

    expect(Date.now() - started).toBeLessThan(2000)
    expect(String(stderr.mock.calls[0]?.[0])).toContain('self-grant not recorded')
  })
})
