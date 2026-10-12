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
import { loggedCount } from '../broker/log.js'
import { HUMAN, type ClientMessage, type ServerMessage } from '../protocol.js'
import { recordSelfGrant } from '../cli/verbs/permission-hook.js'
import { readLedgerFacts } from '../digest/ledger.js'
import { toSourceEvent } from '../mirror/source.js'

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

function setup(dbPath = path.join(tmpDir(), 'events.db')): {
  core: BrokerCore
  server: SocketServer
  wire: () => Wire
} {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(dbPath),
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

  it('is invisible to every human-facing surface even before its resolution lands', () => {
    const dbPath = path.join(tmpDir(), 'events.db')
    const { core, wire } = setup(dbPath)
    const seen: { mirror: unknown; queue: string[]; digest: string[] }[] = []
    core.onAppend(appended => {
      if (appended.kind !== 'approval_request') return
      const row = rows(core).at(-1)!
      const facts = readLedgerFacts(dbPath, 0, Date.now())
      seen.push({
        mirror: toSourceEvent(row, 'test-machine'),
        queue: core.events.humanQueue().map(item => item.msgId),
        digest: facts.escalations.map(entry => entry.msgId),
      })
    })

    wire().send(GRANT)

    expect(seen).toEqual([{ mirror: null, queue: [], digest: [] }])
    expect(rows(core).find(row => row.kind === 'approval_request')?.target).not.toBe(HUMAN)
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

describe('a malformed self-grant record', () => {
  const forged: [string, Record<string, unknown>][] = [
    ['a human session label, which would forge a human allow', { session: 'human' }],
    ['a reserved label in another case', { session: 'System' }],
    ['a session that is not a string', { session: { name: 'scout' } }],
    ['an empty session', { session: '' }],
    ['an over-long session', { session: 's'.repeat(65) }],
    ['a Cyrillic lookalike of human', { session: 'h\u0443man' }],
    ['a human label behind a zero-width space', { session: '\u200bhuman' }],
    ['a human label before a zero-width joiner', { session: 'human\u200d' }],
    ['a human label behind a byte-order mark', { session: '\ufeffhuman' }],
    ['a human label behind a space', { session: ' human' }],
    ['a human label before a space', { session: 'human ' }],
    ['a label holding a tab', { session: 'hu\tman' }],
    ['a label ending in a newline', { session: 'human\n' }],
    ['a fullwidth human label', { session: '\uff48\uff55\uff4d\uff41\uff4e' }],
    ['a label ending in NUL', { session: 'human\u0000' }],
    ['a label holding a dot', { session: 'hu.man' }],
    ['a label opening with a dash', { session: '-scout' }],
    ['a grant other than repo-skills', { grant: 'anything-goes' }],
    ['a toolName that is not a string', { toolName: { name: 'Write' } }],
    ['a tool outside Write, Edit and MultiEdit', { toolName: 'Bash' }],
    ['Bash input with no file_path', { toolInput: { command: 'rm -rf /' } }],
    ['a toolInput that is not an object', { toolInput: 'x' }],
    ['an over-long file_path', { toolInput: { file_path: `/${'p'.repeat(4096)}` } }],
    ['an oversized toolInput', { toolInput: { file_path: '/w/x', content: 'c'.repeat(256 * 1024) } }],
    ['an extra key', { actor: 'human' }],
  ]

  it.each(forged)('is refused with no rows written: %s', (_label, override) => {
    const { core, wire } = setup()
    const hook = wire()
    const before = loggedCount('bad_message')

    hook.send({ ...GRANT, ...override } as ClientMessage)

    expect(hook.frames.at(-1)).toMatchObject({ t: 'permission_hook_result', ok: false })
    expect(loggedCount('bad_message')).toBe(before + 1)
    expect(rows(core)).toHaveLength(0)
  })

  it.each(['claude-f91c0f3a', 'scout', 'a'.repeat(64)])('accepts the session label %s', session => {
    const { core, wire } = setup()

    wire().send({ ...GRANT, session } as ClientMessage)

    expect(rows(core).find(row => row.kind === 'approval_request')).toMatchObject({ actor: session })
  })

  it('can never write a resolution whose actor is human', () => {
    const { core, wire } = setup()
    const hook = wire()

    for (const session of ['human', 'HUMAN', 'Human']) hook.send({ ...GRANT, session } as ClientMessage)
    hook.send(GRANT)

    const resolutions = rows(core).filter(row => row.kind === 'resolution')
    expect(resolutions).toHaveLength(1)
    expect(resolutions.some(row => row.actor.toLowerCase() === HUMAN)).toBe(false)
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
