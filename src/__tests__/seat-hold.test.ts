import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPresence } from '../agents/seats/io.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SEAT_HOLD_MAX, SEAT_HOLD_MAX_AGE_MS } from '../broker/seat-hold.js'
import { SocketServer } from '../broker/socket.js'
import type { DeliveredMessage, ServerMessage } from '../protocol.js'

/**
 * CC-320: the broker keeps a message sent to a dark seat and pushes it when the
 * seat registers. Every name, time and message here is synthetic.
 */

const SEAT = 'seat-hub'
const T0 = Date.parse('2026-09-29T14:46:00.000Z')
const MINUTE = 60_000

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

let dir: string
let core: BrokerCore
let server: SocketServer

const wire = (): Wire => {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  return { conn, frames }
}

function join(name: string): Wire {
  const w = wire()
  server.handleMessage(w.conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1 })
  return w
}

type SendResult = Extract<ServerMessage, { t: 'send_result' }>

function send(from: Wire, to: string, text: string): SendResult {
  server.handleMessage(from.conn, { t: 'send', to, text })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const pushed = (w: Wire): DeliveredMessage[] =>
  w.frames.flatMap(frame => (frame.t === 'deliver' ? [frame.message] : []))

const routeFailures = (): number =>
  core.events.history(1000).filter(item => item.kind === 'route_failed').length

const at = (ms: number): void => void vi.setSystemTime(ms)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0 - 35 * MINUTE)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-hold-'))
  core = new BrokerCore((conn, message) => void conn.write(JSON.stringify({ t: 'deliver', message })), {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
    isSeat: name => name === SEAT,
  })
  server = new SocketServer(core)
})

afterEach(() => {
  server.close()
  core.close()
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** The seat registers, then its connection closes with no teleport at `T0`. */
function seatGoesDark(): void {
  const seat = join(SEAT)
  at(T0)
  core.drop(seat.conn)
}

describe('the dark-seat hold', () => {
  it('holds a report sent while the seat is dark and delivers it after the seat registers', () => {
    seatGoesDark()
    const reviewer = join('rev-one')
    at(T0 + 12 * MINUTE)

    const result = send(reviewer, SEAT, 'Verdict: MERGE')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [SEAT] })
    expect(routeFailures()).toBe(0)
    at(T0 + 47 * MINUTE)
    const back = join(SEAT)
    expect(pushed(back).map(m => [m.from, m.text, m.msgId])).toEqual([
      ['rev-one', 'Verdict: MERGE', result.msgId],
    ])
    expect(back.frames[0]).toMatchObject({ t: 'register_result', ok: true })
  })

  // CC-441. Catches: handleHumanSend failing a dark seat as "no active session" instead of holding it.
  it('holds the watchdog wake sent as the human to a dark seat and delivers it after the seat registers', () => {
    seatGoesDark()
    const watchdog = wire()
    at(T0 + 12 * MINUTE)

    server.handleMessage(watchdog.conn, {
      t: 'human_send',
      to: SEAT,
      text: 'Watchdog: wake',
      source: 'watchdog',
    })
    const result = watchdog.frames.at(-1) as SendResult

    expect(result).toMatchObject({ t: 'send_result', ok: true, held: true, recipients: [SEAT] })
    expect(routeFailures()).toBe(0)
    at(T0 + 13 * MINUTE)
    const back = join(SEAT)
    expect(pushed(back).map(m => [m.from, m.text, m.msgId])).toEqual([
      ['human', 'Watchdog: wake', result.msgId],
    ])
  })

  it('tells the sender the message is held and unread, never delivered', () => {
    seatGoesDark()
    const result = send(join('rev-one'), SEAT, 'Status: DONE')

    expect(result.results).toEqual([expect.objectContaining({ name: SEAT, status: 'held' })])
    expect(result.reason).toContain('has not been delivered or read')
  })

  it('delivers the three reports of the synthetic 47-minute dark stretch, in the order they were sent', () => {
    seatGoesDark()
    const reviewer = join('rev-one')
    const implementer = join('impl-two')
    at(T0 + 12 * MINUTE)
    send(reviewer, SEAT, 'Verdict: MERGE, first')
    send(reviewer, SEAT, 'Verdict: MERGE, second')
    at(T0 + 13 * MINUTE)
    send(implementer, SEAT, 'Status: DONE, third')

    at(T0 + 47 * MINUTE)
    const back = join(SEAT)

    expect(routeFailures()).toBe(0)
    expect(pushed(back).map(m => m.text)).toEqual([
      'Verdict: MERGE, first',
      'Verdict: MERGE, second',
      'Status: DONE, third',
    ])
  })

  it('pushes a held message once: a later register of the same seat gets nothing again', () => {
    seatGoesDark()
    send(join('rev-one'), SEAT, 'Status: DONE')
    const back = join(SEAT)
    at(T0 + 60 * MINUTE)
    core.drop(back.conn)

    expect(pushed(join(SEAT))).toEqual([])
  })

  it('does not push again what the seat received while it was connected', () => {
    const seat = join(SEAT)
    send(join('rev-one'), SEAT, 'seen live')
    expect(pushed(seat)).toHaveLength(1)
    at(T0)
    core.drop(seat.conn)

    expect(pushed(join(SEAT))).toEqual([])
  })

  it('refuses the message past the count bound and keeps the ones it already promised', () => {
    seatGoesDark()
    const sender = join('rev-one')
    for (let i = 0; i < SEAT_HOLD_MAX; i++) core.holdForSeat(`impl-${i}`, SEAT, `report ${i}`)

    const overflow = send(sender, SEAT, 'one too many')

    expect(overflow).toMatchObject({ ok: false })
    expect(overflow.reason).toContain('its hold is full')
    expect(routeFailures()).toBe(1)
    const texts = pushed(join(SEAT)).map(m => m.text)
    expect(texts).toHaveLength(SEAT_HOLD_MAX)
    expect([texts[0], texts.at(-1)]).toEqual(['report 0', `report ${SEAT_HOLD_MAX - 1}`])
  })

  it('takes no new hold for a seat dark past the age bound', () => {
    seatGoesDark()
    const sender = join('rev-one')
    at(T0 + SEAT_HOLD_MAX_AGE_MS + MINUTE)

    const result = send(sender, SEAT, 'Status: DONE')

    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('dark too long')
    expect(routeFailures()).toBe(1)
  })

  it('leaves a held message older than the age bound in the inbox instead of pushing it', () => {
    seatGoesDark()
    send(join('rev-one'), SEAT, 'stale report')
    at(T0 + SEAT_HOLD_MAX_AGE_MS + MINUTE)

    expect(pushed(join(SEAT))).toEqual([])
    expect(core.events.inboxFor(SEAT, 10).map(m => m.text)).toEqual(['stale report'])
  })

  it('still fails a send to a dark name that is not a seat', () => {
    const worker = join('impl-two')
    at(T0)
    core.drop(worker.conn)

    const result = send(join('rev-one'), 'impl-two', 'hello')

    expect(result).toMatchObject({ ok: false, reason: 'no active session named "impl-two"' })
    expect(routeFailures()).toBe(1)
  })

  it('still fails a send to a seat name that has never registered', () => {
    const result = send(join('rev-one'), SEAT, 'hello')

    expect(result).toMatchObject({ ok: false, reason: `no active session named "${SEAT}"` })
  })

  it('stops holding once the seat has registered again, even with an older deregister on record', () => {
    seatGoesDark()
    join(SEAT)

    expect(core.events.darkSince(SEAT)).toBeUndefined()
    expect(core.darkSeat(SEAT)).toBeUndefined()
  })
})

describe('a seat the broker never deregistered (CC-326)', () => {
  /** The broker dies with the seat connected, so no `deregistered` row is written, then boots again. */
  function brokerRestarts(): void {
    server.close()
    core.close()
    core = new BrokerCore((conn, message) => void conn.write(JSON.stringify({ t: 'deliver', message })), {
      events: new EventLog(path.join(dir, 'events.db')),
      registry: new Registry<Conn>(),
      isSeat: name => name === SEAT,
    })
    server = new SocketServer(core)
  }

  it('holds a report for a seat absent after boot and delivers it when the seat registers', () => {
    join(SEAT)
    at(T0)
    brokerRestarts()
    at(T0 + 3 * MINUTE)

    const result = send(join('rev-one'), SEAT, 'Verdict: MERGE')

    expect(result).toMatchObject({ ok: true, held: true })
    expect(core.events.darkSince(SEAT)?.at).toBe(T0)
    const back = join(SEAT)
    expect(pushed(back).map(m => m.text)).toEqual(['Verdict: MERGE'])
    expect(core.events.darkSince(SEAT)).toBeUndefined()
  })

  it('does not push again what the seat received before the restart', () => {
    const seat = join(SEAT)
    send(join('rev-one'), SEAT, 'seen live')
    expect(pushed(seat)).toHaveLength(1)
    brokerRestarts()

    expect(pushed(join(SEAT))).toEqual([])
  })

  it('does not count a seat that registered after boot as dark', () => {
    brokerRestarts()
    join(SEAT)

    expect(core.events.darkSince(SEAT)).toBeUndefined()
  })

  it('reads the unclosed register as open for the watchdog, and as closed once the seat is back', () => {
    join(SEAT)
    brokerRestarts()
    const open = readPresence(path.join(dir, 'events.db'), SEAT)
    expect(open.darkSince).toBeUndefined()
    expect(open.openRegister).toBeGreaterThan(0)

    core.drop(join(SEAT).conn)
    expect(readPresence(path.join(dir, 'events.db'), SEAT).openRegister).toBeUndefined()
  })
})

describe('readPresence', () => {
  const presence = () => readPresence(path.join(dir, 'events.db'), SEAT)
  const resumedByWatchdog = (): void =>
    void core.append({ kind: 'agent_resumed', actor: 'human', target: SEAT, meta: { source: 'watchdog' } })

  it('reads a connection closed with no teleport as dark since the deregister', () => {
    seatGoesDark()
    expect(presence()).toEqual({
      darkSince: T0,
      registeredAt: T0 - 35 * MINUTE,
      teleported: false,
      wokenByWatchdog: false,
      resumeStarted: false,
    })
  })

  it('reads a seat that registered again as not dark', () => {
    seatGoesDark()
    join(SEAT)
    expect(presence().darkSince).toBeUndefined()
  })

  const teleports = (): void => {
    core.append({ kind: 'agent_handoff', actor: SEAT, body: 'handoff' })
    core.append({ kind: 'agent_stood_down', actor: SEAT })
  }

  it('reads a handoff and stand-down written since the last register as a teleport', () => {
    const seat = join(SEAT)
    teleports()
    core.drop(seat.conn)
    expect(presence()).toMatchObject({ teleported: true })
  })

  it('reads a stand-down written after the session closed as a teleport', () => {
    const seat = join(SEAT)
    core.append({ kind: 'agent_handoff', actor: SEAT, body: 'handoff' })
    core.drop(seat.conn)
    core.append({ kind: 'agent_stood_down', actor: SEAT })
    expect(presence()).toMatchObject({ teleported: true })
  })

  it('does not let the handoff row of an aborted teleport mask a later death', () => {
    const seat = join(SEAT)
    core.append({ kind: 'agent_handoff', actor: SEAT, body: 'handoff' })
    at(T0)
    core.drop(seat.conn)
    expect(presence()).toMatchObject({ darkSince: T0, teleported: false })
  })

  it('reads a seat that never registered as neither dark nor open', () => {
    expect(presence()).toEqual({ teleported: false, wokenByWatchdog: false, resumeStarted: false })
  })

  it('reads a resume started since the seat went dark, by the watchdog or anyone, as started', () => {
    seatGoesDark()
    core.append({ kind: 'agent_resumed', actor: 'human', target: SEAT })
    expect(presence()).toMatchObject({ darkSince: T0, resumeStarted: true })
  })

  const launchThrew = (): void =>
    void core.append({ kind: 'agent_exited', actor: SEAT, meta: { failed: 'true', never_started: 'true' } })

  it('does not read a resume whose launch threw as started, nor as a watchdog wake', () => {
    seatGoesDark()
    resumedByWatchdog()
    launchThrew()
    expect(presence()).toMatchObject({ resumeStarted: false, wokenByWatchdog: false })
  })

  it('reads a second resume as started while the first one that threw is on record', () => {
    seatGoesDark()
    resumedByWatchdog()
    launchThrew()
    resumedByWatchdog()
    expect(presence().resumeStarted).toBe(true)
  })

  it('reads a resume that launched and exited before it registered as started', () => {
    seatGoesDark()
    resumedByWatchdog()
    core.append({ kind: 'agent_exited', actor: SEAT, meta: { failed: 'true' } })
    expect(presence().resumeStarted).toBe(true)
  })

  it('does not read a session a person started after a watchdog resume threw as a watchdog wake', () => {
    seatGoesDark()
    resumedByWatchdog()
    launchThrew()
    core.drop(join(SEAT).conn)
    expect(presence().wokenByWatchdog).toBe(false)
  })

  it('does not read a resume sent while the seat was connected as started once it goes dark', () => {
    const seat = join(SEAT)
    core.append({ kind: 'agent_resumed', actor: 'human', target: SEAT })
    core.drop(seat.conn)
    expect(presence().resumeStarted).toBe(false)
  })

  it('does not read a resume from before the seat went dark as started', () => {
    core.append({ kind: 'agent_resumed', actor: 'human', target: SEAT })
    seatGoesDark()
    expect(presence().resumeStarted).toBe(false)
    core.drop(join(SEAT).conn)
    expect(presence().resumeStarted).toBe(false)
  })

  it('does not read an earlier teleport as one after the successor registered', () => {
    const seat = join(SEAT)
    teleports()
    core.drop(seat.conn)
    core.drop(join(SEAT).conn)
    expect(presence()).toMatchObject({ teleported: false })
  })

  it('reads a session the watchdog resumed as woken by it, until something else starts one', () => {
    seatGoesDark()
    resumedByWatchdog()
    const woken = join(SEAT)
    core.drop(woken.conn)
    expect(presence().wokenByWatchdog).toBe(true)

    core.drop(join(SEAT).conn)
    expect(presence().wokenByWatchdog).toBe(false)
  })
})
