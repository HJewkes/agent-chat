import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { DeliveredMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1552: a retired or parked agent that still holds a socket is pushed no peer mail and no
 * lifecycle events; they wait in its inbox, or go to the owner queue for a seat with a steward.
 * Every name, time and message here is synthetic.
 */

const AGENT = 'coord-old'
const SEAT = 'seat-pc'
const STEWARD = 'seat-tc'
const T0 = Date.parse('2026-10-21T09:00:00.000Z')
const MINUTE = 60_000

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

type SendResult = Extract<ServerMessage, { t: 'send_result' }>

let dir: string
let core: BrokerCore
let server: SocketServer

const wire = (): Wire => {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  return { conn, frames }
}

function join(name: string, ids: { sessionId?: string; agentId?: string } = {}): Wire {
  const w = wire()
  server.handleMessage(w.conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1, ...ids })
  return w
}

/** A hand-started session, so it is bound to an adopted identity the way a seat is. */
const joinAdopted = (name: string): Wire => join(name, { sessionId: `session-${name}` })

const agentIdOf = (w: Wire): string => core.registry.entryFor(w.conn)?.agentId as string

function send(from: Wire, to: string, text: string): SendResult {
  server.handleMessage(from.conn, { t: 'send', to, text })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const pushed = (w: Wire): DeliveredMessage[] =>
  w.frames.flatMap(frame => (frame.t === 'deliver' ? [frame.message] : []))

const inbox = (name: string): string[] => core.events.inboxFor(name, 100).map(m => m.text)

const retire = (w: Wire, name: string): void =>
  void core.append({ kind: 'agent_retired', actor: 'human', target: name, ref: agentIdOf(w), body: '' })

const parkTree = (w: Wire, name: string): void =>
  void core.append({ kind: 'isolation_parked', actor: name, ref: agentIdOf(w), body: '', meta: {} })

/** `name` teleports with `reason`, and its successor registers under the same name. */
function teleportInto(name: string, reason: string): Wire {
  const predecessor = joinAdopted(name)
  const predecessorId = agentIdOf(predecessor)
  core.drop(predecessor.conn)
  const { msgId: successorId } = core.append({
    kind: 'agent_spawned',
    actor: 'agent-chat',
    target: name,
    body: '',
    meta: { origin: 'adopted', name, cwd: '/tmp', teleport_from: predecessorId },
  })
  core.append({
    kind: 'agent_handoff',
    actor: name,
    ref: predecessorId,
    body: 'waiting on the owner',
    meta: { successor: successorId, reason },
  })
  return join(name, { agentId: successorId })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-push-hold-'))
  process.env.AGENT_CHAT_HOME = dir
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ seatStewards: { [SEAT]: STEWARD } }))
  core = new BrokerCore((conn, message) => void conn.write(JSON.stringify({ t: 'deliver', message })), {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
    isSeat: name => [SEAT, STEWARD].includes(name),
  })
  server = new SocketServer(core)
})

afterEach(() => {
  server.close()
  core.close()
  delete process.env.AGENT_CHAT_HOME
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pushes to a retired or parked agent', () => {
  // Catches: the route's `live` ignoring the identity, so a retired session is still woken.
  it('holds a peer message for a retired agent that still has a session and says so', () => {
    const retired = joinAdopted(AGENT)
    retire(retired, AGENT)
    const sender = join('rev-one')

    const result = send(sender, AGENT, 'Verdict: MERGE')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [AGENT] })
    expect(result.results?.[0]).toMatchObject({ name: AGENT, status: 'held' })
    expect(result.results?.[0]?.reason).toContain('retired')
    expect(pushed(retired)).toEqual([])
    expect(inbox(AGENT)).toEqual(['Verdict: MERGE'])
  })

  // Catches: a hold keyed on the name rather than the identity, which would silence a live agent.
  it('pushes a peer message to an agent that is neither retired nor parked', () => {
    const live = joinAdopted(AGENT)
    const sender = join('rev-one')

    const result = send(sender, AGENT, 'Verdict: MERGE')

    expect(result).toMatchObject({ ok: true, recipients: [AGENT] })
    expect(result.held).toBeUndefined()
    expect(pushed(live).map(m => m.text)).toEqual(['Verdict: MERGE'])
  })

  it('holds a peer message for an agent whose tree was parked', () => {
    const parked = joinAdopted(AGENT)
    parkTree(parked, AGENT)
    const sender = join('rev-one')

    const result = send(sender, AGENT, 'CI is green')

    expect(result).toMatchObject({ ok: true, held: true })
    expect(result.results?.[0]?.reason).toContain('parked')
    expect(pushed(parked)).toEqual([])
    expect(inbox(AGENT)).toEqual(['CI is green'])
  })

  // Catches: treating a park as permanent, so a resumed fix round is never woken again.
  it('pushes again once a parked agent is resumed', () => {
    const parked = joinAdopted(AGENT)
    parkTree(parked, AGENT)
    core.append({ kind: 'agent_resumed', actor: 'human', target: AGENT, ref: agentIdOf(parked), body: '' })
    const sender = join('rev-one')

    send(sender, AGENT, 'Fix round 2')

    expect(pushed(parked).map(m => m.text)).toEqual(['Fix round 2'])
  })

  it("holds a peer message for a park teleport's successor until the human answers it", () => {
    const successor = teleportInto(AGENT, 'park')
    const sender = join('rev-one')

    const before = send(sender, AGENT, 'Any news?')
    vi.setSystemTime(T0 + MINUTE)
    server.handleMessage(wire().conn, { t: 'human_send', to: AGENT, text: 'Go ahead' })
    send(sender, AGENT, 'Ready for review')

    expect(before).toMatchObject({ ok: true, held: true })
    expect(pushed(successor).map(m => m.text)).toEqual(['Any news?', 'Go ahead', 'Ready for review'])
  })

  // Catches: holding every teleport successor, not only one that parked.
  it('pushes to the successor of a teleport that did not park', () => {
    const successor = teleportInto(AGENT, 'account')
    const sender = join('rev-one')

    send(sender, AGENT, 'Any news?')

    expect(pushed(successor).map(m => m.text)).toEqual(['Any news?'])
  })

  it('forwards a peer message for a retired seat with a steward to the owner queue, waking nobody', () => {
    const seat = joinAdopted(SEAT)
    retire(seat, SEAT)
    const steward = join(STEWARD)
    const sender = join('rev-one')

    const result = send(sender, SEAT, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, recipients: ['human'] })
    expect(result.reason).toContain('owner queue')
    const queued = core.events.humanQueue().filter(item => item.meta.forwarded_for === SEAT)
    expect(queued.map(item => item.text)).toEqual([`[for ${SEAT}] Merged: #42`])
    expect(pushed(seat)).toEqual([])
    expect(pushed(steward)).toEqual([])
  })

  // Catches: subscribersFor skipping only do-not-disturb, so a retired coordinator hears every exit.
  it('pushes no lifecycle event to a retired subscriber', () => {
    const retired = joinAdopted(AGENT)
    const watcher = joinAdopted('watcher')
    for (const w of [retired, watcher])
      server.handleMessage(w.conn, {
        t: 'subscribe',
        subscriptions: [{ selector: { name: 'worker' }, kinds: ['registered'] }],
      })
    retire(retired, AGENT)

    const subscribers = core.registry.subscribersFor({ kind: 'registered', subject: 'worker' })

    expect(subscribers).toEqual([watcher.conn])
  })
})

describe('automated wakes to a parked or retired seat (CC-1550)', () => {
  const wake = (to: string, text: string): SendResult => {
    const sender = wire()
    server.handleMessage(sender.conn, { t: 'human_send', to, text, source: 'watchdog' })
    return sender.frames.find((f): f is SendResult => f.t === 'send_result') as SendResult
  }

  // Catches: an automated wake taking the owner's override, so a parked seat is woken every tick.
  it('pushes no watchdog wake to a seat whose tree was parked, and keeps it in the inbox', () => {
    const parked = joinAdopted(SEAT)
    parkTree(parked, SEAT)

    const result = wake(SEAT, 'Heartbeat tick')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [SEAT] })
    expect(result.reason).toContain('parked')
    expect(pushed(parked)).toEqual([])
    expect(inbox(SEAT)).toEqual(['Heartbeat tick'])
  })

  it('pushes no watchdog wake to a retired seat that still has a session', () => {
    const retired = joinAdopted(SEAT)
    retire(retired, SEAT)

    const result = wake(SEAT, 'Heartbeat tick')

    expect(result).toMatchObject({ ok: true, held: true })
    expect(result.reason).toContain('retired')
    expect(pushed(retired)).toEqual([])
  })

  // Catches: a hold applied to every sourced send, which would silence a live seat's heartbeat.
  it('still pushes a watchdog wake to a live seat', () => {
    const live = joinAdopted(SEAT)

    const result = wake(SEAT, 'Heartbeat tick')

    expect(result).toMatchObject({ ok: true, recipients: [SEAT] })
    expect(result.held).toBeUndefined()
    expect(pushed(live).map(m => m.text)).toEqual(['Heartbeat tick'])
  })

  // Catches: the wake's own row reading as the owner's word and unparking a park teleport's successor.
  it("leaves a park teleport's successor parked after a watchdog wake", () => {
    const successor = teleportInto(AGENT, 'park')
    wake(AGENT, 'Heartbeat tick')

    send(join('rev-one'), AGENT, 'Any news?')

    expect(pushed(successor)).toEqual([])
  })

  it("still pushes the owner's own words to a parked seat", () => {
    const parked = joinAdopted(SEAT)
    parkTree(parked, SEAT)

    server.handleMessage(wire().conn, { t: 'human_send', to: SEAT, text: 'Go ahead' })

    expect(pushed(parked).map(m => m.text)).toEqual(['Go ahead'])
  })
})

describe('mail held while an agent was parked', () => {
  const resume = (agentId: string, name: string): void =>
    void core.append({ kind: 'agent_resumed', actor: 'human', target: name, ref: agentId, body: '' })

  // Catches: append never flushing, or flushing twice: a second resume must not push the mail again.
  it('pushes it in order, once, when the connected agent is resumed', () => {
    const parked = joinAdopted(AGENT)
    parkTree(parked, AGENT)
    const sender = join('rev-one')
    send(sender, AGENT, 'CI is green')
    send(sender, AGENT, 'Review is in')

    resume(agentIdOf(parked), AGENT)
    resume(agentIdOf(parked), AGENT)

    expect(pushed(parked).map(m => m.text)).toEqual(['CI is green', 'Review is in'])
  })

  // Catches: flushing only to the session that was parked, when a resume starts a new one.
  it('pushes it to the session a resume starts once that session attaches', () => {
    const parked = joinAdopted(AGENT)
    const agentId = agentIdOf(parked)
    parkTree(parked, AGENT)
    send(join('rev-one'), AGENT, 'CI is green')
    core.drop(parked.conn)
    resume(agentId, AGENT)

    const resumed = join(AGENT, { agentId })

    expect(pushed(resumed).map(m => m.text)).toEqual(['CI is green'])
  })

  // Catches: pushing the held mail on any row about the agent, before it is unparked.
  it('keeps holding it while the agent stays parked', () => {
    const parked = joinAdopted(AGENT)
    parkTree(parked, AGENT)
    const sender = join('rev-one')
    send(sender, AGENT, 'CI is green')

    send(sender, AGENT, 'Still there?')

    expect(pushed(parked)).toEqual([])
  })

  it('pushes nothing to a retired agent', () => {
    const agent = joinAdopted(AGENT)
    parkTree(agent, AGENT)
    send(join('rev-one'), AGENT, 'CI is green')
    retire(agent, AGENT)

    server.handleMessage(wire().conn, { t: 'human_send', to: AGENT, text: 'Go ahead' })

    expect(pushed(agent).map(m => m.text)).not.toContain('CI is green')
    expect(inbox(AGENT)).toContain('CI is green')
  })
})
