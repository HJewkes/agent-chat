import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { pairPresence } from '../agents/identity.js'
import { spawnedIdentity } from '../server/index.js'
import { ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ServerMessage } from '../protocol.js'

/**
 * A2 — the presence bridge. What is being proved is that a process can attach to
 * a durable identity, become an ordinary peer, and leave without taking the
 * identity with it. No spawning code exists yet, and that is the point of the
 * ordering: if this does not work, no amount of spawn machinery would help.
 */

const tmpDirs: string[] = []

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-presence-'))
  tmpDirs.push(dir)
  return new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

/** Mint a durable identity the way a supervisor eventually will. */
function spawn(core: BrokerCore, id: string, name: string): void {
  core.append({ kind: 'agent_spawned', actor: 'human', target: name, msgId: id, body: `brief for ${name}` })
}

const attach = (core: BrokerCore, conn: Conn, name: string, agentId?: string, evict?: (c: Conn) => void) =>
  core.register(
    conn,
    { t: 'register', name, workingOn: 'working', cwd: '/tmp', pid: 1, ...(agentId ? { agentId } : {}) },
    evict,
  )

const kindsFor = (core: BrokerCore, id: string): string[] =>
  core.events
    .agentEvents()
    .filter(r => r.ref === id || r.msgId === id)
    .map(r => r.kind)

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('attaching a process to a durable identity', () => {
  it('registers, and records the attach against the identity', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')

    expect(attach(core, fakeConn(), 'scout', 'a1').ok).toBe(true)
    expect(kindsFor(core, 'a1')).toEqual(['agent_spawned', 'agent_attached'])
    expect(core.agents.get('a1')?.state).toBe('live')
  })

  it('makes the agent an ordinary peer, reachable by name like any session', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    attach(core, fakeConn(), 'scout', 'a1')

    expect(core.registry.list().map(s => s.name)).toContain('scout')
  })

  it('leaves the identity behind when the socket goes, rather than taking it along', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    const conn = fakeConn()
    attach(core, conn, 'scout', 'a1')

    core.drop(conn)

    expect(core.registry.list()).toHaveLength(0)
    expect(core.agents.get('a1')?.state).toBe('detached')
    expect(core.agents.nameIsClaimed('scout')).toBe(true)
    expect(kindsFor(core, 'a1')).toContain('agent_detached')
  })

  it('still records a plain session leaving, without inventing an identity for it', () => {
    const core = makeCore()
    const conn = fakeConn()
    attach(core, conn, 'plain')
    core.drop(conn)

    expect(core.events.agentEvents()).toHaveLength(0)
    expect(core.agents.roster()).toHaveLength(0)
  })
})

describe('an agent id is not enough on its own', () => {
  it('refuses an id that names no agent', () => {
    const core = makeCore()
    const result = attach(core, fakeConn(), 'scout', 'nope')

    expect(result).toMatchObject({ ok: false, reason: 'no agent with id nope' })
  })

  it('refuses a session borrowing a real id under the wrong name', () => {
    // Ids are 8-char slices visible in the log to every session on the machine,
    // so the name binding is what stops a peer registering as an agent it merely
    // read about and inheriting that agent's peers.
    const core = makeCore()
    spawn(core, 'a1', 'scout')

    const result = attach(core, fakeConn(), 'impostor', 'a1')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/is "scout", not "impostor"/)
    expect(kindsFor(core, 'a1')).not.toContain('agent_attached')
  })

  it('refuses to attach to a retired identity, whose name may already be reused', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    core.append({ kind: 'agent_retired', actor: 'human', target: 'scout', ref: 'a1' })

    expect(attach(core, fakeConn(), 'scout', 'a1').reason).toMatch(/has been retired/)
  })
})

describe('the takeover rule', () => {
  it('lets the same identity supersede its own stale connection', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    const dead = fakeConn()
    attach(core, dead, 'scout', 'a1')

    const evicted: Conn[] = []
    const resumed = attach(core, fakeConn(), 'scout', 'a1', c => evicted.push(c))

    expect(resumed.ok).toBe(true)
    expect(evicted).toEqual([dead])
    expect(core.registry.list()).toHaveLength(1)
  })

  it('records the detach for the superseded process before the attach for the new one', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    attach(core, fakeConn(), 'scout', 'a1')
    attach(core, fakeConn(), 'scout', 'a1')

    expect(kindsFor(core, 'a1')).toEqual([
      'agent_spawned',
      'agent_attached',
      'agent_detached',
      'agent_attached',
    ])
    expect(core.agents.get('a1')?.state).toBe('live')
  })

  it('leaves the superseded connection with nothing to record when its close finally fires', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    const dead = fakeConn()
    attach(core, dead, 'scout', 'a1')
    attach(core, fakeConn(), 'scout', 'a1')

    core.drop(dead)

    // A second detach here would fold the live agent back to `detached` and make
    // a successful resume look like a failed one.
    expect(kindsFor(core, 'a1').filter(k => k === 'agent_detached')).toHaveLength(1)
    expect(core.agents.get('a1')?.state).toBe('live')
  })

  it('still refuses an ordinary name collision, which is the rule it must not weaken', () => {
    const core = makeCore()
    attach(core, fakeConn(), 'scout')

    expect(attach(core, fakeConn(), 'scout').reason).toMatch(/held by another session/)
  })

  it('refuses a different agent reaching for a name a live agent holds', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    spawn(core, 'a2', 'scout')
    attach(core, fakeConn(), 'scout', 'a1')

    expect(attach(core, fakeConn(), 'scout', 'a2').reason).toMatch(/held by another session/)
  })
})

describe('presence paired with the identity it attached to', () => {
  it('reads as running while attached and detached once the process is gone', () => {
    const core = makeCore()
    spawn(core, 'a1', 'scout')
    const conn = fakeConn()
    attach(core, conn, 'scout', 'a1')

    const live = core.agents.get('a1')!
    expect(pairPresence(live, { connected: core.registry.connFor('scout') !== undefined }).status).toBe(
      'running',
    )

    core.drop(conn)
    const gone = core.agents.get('a1')!
    expect(pairPresence(gone, { connected: core.registry.connFor('scout') !== undefined }).status).toBe(
      'detached',
    )
  })
})

describe('identity from the spawn environment', () => {
  it('needs both halves, because either alone is not an agent', () => {
    expect(spawnedIdentity({})).toBeUndefined()
    expect(spawnedIdentity({ AGENT_CHAT_AGENT_ID: 'a1' })).toBeUndefined()
    expect(spawnedIdentity({ AGENT_CHAT_NAME: 'scout' })).toBeUndefined()
  })

  it('reads the pair, with a placeholder until the agent says what it is doing', () => {
    const identity = spawnedIdentity({ AGENT_CHAT_AGENT_ID: 'a1', AGENT_CHAT_NAME: 'scout' })

    expect(identity).toMatchObject({ agentId: 'a1', name: 'scout' })
    expect(identity?.workingOn).toBeTruthy()
  })

  it('takes a supplied working_on over the placeholder', () => {
    const identity = spawnedIdentity({
      AGENT_CHAT_AGENT_ID: 'a1',
      AGENT_CHAT_NAME: 'scout',
      AGENT_CHAT_WORKING_ON: 'reading the log',
    })

    expect(identity?.workingOn).toBe('reading the log')
  })
})

describe('the seeded tool handler', () => {
  const stubBroker = (reply: ServerMessage) => ({ request: async () => reply }) as unknown as BrokerClient

  const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text

  it('lets a spawned agent send without ever calling chat_register', async () => {
    // The bug this exists to prevent: the broker knows the name, the handler does
    // not, and the agent is visible to every peer while unable to answer any.
    const handler = new ToolHandler(
      stubBroker({ t: 'send_result', ok: true, msgId: 'm1', recipients: ['bob'] }),
      'scout',
    )

    const result = await handler.handle('chat_send', { to: 'bob', text: 'hello' })

    expect(textOf(result)).not.toMatch(/chat_register/)
  })

  it('treats re-registering the same name as a no-op success', async () => {
    const handler = new ToolHandler(stubBroker({ t: 'register_result', ok: true }), 'scout')

    expect(textOf(await handler.handle('chat_register', { name: 'scout' }))).toMatch(/Already registered/)
  })

  it('refuses a rename, which would strand every peer told to use the old name', async () => {
    const handler = new ToolHandler(stubBroker({ t: 'register_result', ok: true }), 'scout')

    const result = textOf(await handler.handle('chat_register', { name: 'something-else' }))

    expect(result).toMatch(/already registered as "scout"/)
    expect(result).toMatch(/fixed for this session/)
  })

  it('leaves an unseeded session registering normally', async () => {
    const handler = new ToolHandler(stubBroker({ t: 'register_result', ok: true }))

    expect(textOf(await handler.handle('chat_register', { name: 'cc-main' }))).toMatch(
      /Registered as "cc-main"/,
    )
  })
})
