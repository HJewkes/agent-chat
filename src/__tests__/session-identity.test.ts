import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SystemEventFeed } from '../broker/subscriptions.js'
import type { ClientMessage } from '../protocol.js'

/**
 * CC-30 — an ordinary human-started session gets a durable identity.
 *
 * The property under test throughout is the hinge: the DURABLE half is written
 * (an id, the Claude Code session id, the log rows a succession edge can hang
 * on) and the EPHEMERAL half is not (presence, and the pid that only means
 * anything while a process is alive). A test that finds a pid in the log is
 * finding the bug this design exists to avoid.
 */

const tmpDirs: string[] = []

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-adopt-'))
  tmpDirs.push(dir)
  return new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

type RegisterMessage = Extract<ClientMessage, { t: 'register' }>

const registration = (over: Partial<RegisterMessage> = {}): RegisterMessage => ({
  t: 'register',
  name: 'alpha',
  workingOn: 'CC-30',
  cwd: '/tmp/project',
  pid: 4242,
  sessionId: 'sess-abc',
  hostPid: 4241,
  ...over,
})

const adoptedRows = (core: BrokerCore) =>
  core.events.agentEvents().filter(r => r.kind === 'agent_spawned' && r.meta.origin === 'adopted')

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('adopting a human-started session', () => {
  it('gives it an identity the broker can name', () => {
    const core = makeCore()
    core.register(fakeConn(), registration())

    const roster = core.agents.roster()
    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({ name: 'alpha', origin: 'adopted', state: 'live', brief: 'CC-30' })
  })

  it('mints the id itself rather than taking one the session offered', () => {
    // The whole point of the distinction: a spawned agent is trustworthy because
    // the BROKER minted its id. An adopted one has to be minted the same way.
    const core = makeCore()
    core.register(fakeConn(), registration())

    const [row] = adoptedRows(core)
    expect(row?.msgId).toBeTruthy()
    expect(row?.msgId).not.toBe('sess-abc')
  })

  it('records the Claude Code session id, which is what makes the transcript findable', () => {
    const core = makeCore()
    core.register(fakeConn(), registration())

    expect(core.agents.roster()[0]?.sessionId).toBe('sess-abc')
  })

  it('attributes the session to the human, since a human started it', () => {
    const core = makeCore()
    core.register(fakeConn(), registration())

    expect(core.agents.roster()[0]?.spawnedBy).toBe('human')
  })

  it('leaves a client with no session id exactly as it was', () => {
    // A raw socket client, or an older binary. Adoption is opt-in on evidence
    // the process has, so its absence must cost nothing.
    const core = makeCore()
    const noSessionId = registration()
    delete noSessionId.sessionId
    core.register(fakeConn(), noSessionId)

    expect(core.agents.roster()).toHaveLength(0)
    expect(core.events.history(10).map(r => r.kind)).toEqual(['registered'])
  })

  it('gives a spawn row an id to hang a succession edge on', () => {
    // Gap 2: without a row whose msgId IS the agent id, `meta.teleport_from` has
    // nothing to reference and teleport's safety property has no anchor.
    const core = makeCore()
    core.register(fakeConn(), registration())

    const [row] = adoptedRows(core)
    expect(row?.msgId).toBe(core.agents.roster()[0]?.agentId)
  })
})

describe('a session coming back on a new socket', () => {
  it('re-attaches to the identity it already has instead of minting a second', () => {
    const core = makeCore()
    const first = fakeConn()
    core.register(first, registration())
    const original = core.agents.roster()[0]?.agentId
    core.drop(first)

    core.register(fakeConn(), registration())

    expect(adoptedRows(core)).toHaveLength(1)
    expect(core.agents.roster()[0]?.agentId).toBe(original)
    expect(core.agents.roster()[0]?.state).toBe('live')
  })

  it('keeps the identity when presence ends, which is the half that is durable', () => {
    const core = makeCore()
    const conn = fakeConn()
    core.register(conn, registration())
    core.drop(conn)

    expect(core.registry.list()).toHaveLength(0)
    expect(core.agents.roster()[0]?.state).toBe('detached')
  })

  it('follows a rename without leaving a second identity behind', () => {
    const core = makeCore()
    const conn = fakeConn()
    core.register(conn, registration())
    core.register(conn, registration({ name: 'alpha-two' }))

    expect(adoptedRows(core)).toHaveLength(1)
    expect(core.agents.roster()[0]?.name).toBe('alpha-two')
  })

  it('mints nothing when the name is held by another live session', () => {
    // A stranded identity would hold a spawn row nothing can ever attach to.
    const core = makeCore()
    core.register(fakeConn(), registration({ sessionId: 'sess-one' }))

    const result = core.register(fakeConn(), registration({ sessionId: 'sess-two' }))

    expect(result.ok).toBe(false)
    expect(adoptedRows(core)).toHaveLength(1)
  })
})

describe('what adoption must not become', () => {
  it('does not let a session id evict the live holder of a name', () => {
    // The regression this caught for real: resolving the identity BEFORE the
    // registry meant a second process quoting the same session id reached the
    // resume-takeover rule, evicted the holder and killed it with a fatal frame.
    // Only an id the broker minted and handed over in an environment may do that.
    const core = makeCore()
    const holder = fakeConn()
    core.register(holder, registration())

    const result = core.register(fakeConn(), registration())

    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toMatch(/held by another session/)
    expect(core.registry.connFor('alpha')).toBe(holder)
  })

  it('does not hand over a spawned agent to a session quoting its session id', () => {
    const core = makeCore()
    core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'scout',
      msgId: 'spawned1',
      meta: { session_id: 'sess-abc', profile: 'explorer' },
    })

    core.register(fakeConn(), registration({ name: 'alpha', sessionId: 'sess-abc' }))

    const attached = core.events.agentEvents().filter(r => r.kind === 'agent_attached')
    expect(attached.map(r => r.ref)).not.toContain('spawned1')
    expect(core.agents.get('spawned1')?.state).toBe('spawning')
  })

  it('never writes the host pid to the log, because a pid is presence', () => {
    const core = makeCore()
    core.register(fakeConn(), registration({ hostPid: 99_001 }))

    const written = JSON.stringify(core.events.history(20))
    expect(written).not.toContain('99001')
    expect(written).not.toContain('host_pid')
  })

  it('keeps the host pid on the connection, where it dies with the process', () => {
    // Gap 3: `pid` is the MCP subprocess, which is the wrong thing to signal.
    const core = makeCore()
    const conn = fakeConn()
    core.register(conn, registration({ pid: 4242, hostPid: 4241 }))

    expect(core.registry.entryFor(conn)?.hostPid).toBe(4241)
    core.drop(conn)
    expect(core.registry.entryFor(conn)).toBeUndefined()
  })
})

describe('the subscription feed', () => {
  it('does not report an adopted mint twice to a subscriber', () => {
    // `registered` already carries this event. A subscriber's stream must not
    // double up on the day ordinary sessions gained identities.
    const registry = new Registry<string>()
    const pushed: string[] = []
    const feed = new SystemEventFeed<string>(registry, (_conn, events) => {
      for (const event of events) pushed.push(event.kind)
    })
    registry.register('watcher', {
      name: 'watcher',
      workingOn: 'watching',
      cwd: '/tmp',
      pid: 1,
      subscriptions: [{ selector: { all: true }, kinds: ['registered', 'agent_spawned'] }],
    })

    feed.offer({ kind: 'registered', actor: 'alpha' })
    feed.offer({ kind: 'agent_spawned', actor: 'human', target: 'alpha', meta: { origin: 'adopted' } })
    feed.offer({ kind: 'agent_spawned', actor: 'human', target: 'scout', meta: { profile: 'explorer' } })
    feed.flush()

    expect(pushed).toEqual(['registered', 'agent_spawned'])
    feed.close()
  })
})
