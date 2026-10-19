import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SEAT_HOLD_MARK } from '../broker/seat-hold.js'
import { SocketServer } from '../broker/socket.js'
import type { DeliveredMessage, ServerMessage } from '../protocol.js'

/**
 * CC-966 and CC-1501: a message to a non-resident seat (one `seatStewards` names) with no session
 * goes to the owner queue, not to its steward, instead of waiting in a hold nobody reads. Every
 * name, time and message here is synthetic.
 */

const SEAT = 'seat-pc'
const STEWARD = 'seat-tc'
const UNMAPPED = 'seat-dc'
const T0 = Date.parse('2026-10-11T02:19:00.000Z')
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

function join(name: string): Wire {
  const w = wire()
  server.handleMessage(w.conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1 })
  return w
}

function goDark(name: string): void {
  core.drop(join(name).conn)
}

function send(from: Wire, to: string, text: string, inReplyTo?: string): SendResult {
  server.handleMessage(from.conn, { t: 'send', to, text, ...(inReplyTo === undefined ? {} : { inReplyTo }) })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const pushed = (w: Wire): DeliveredMessage[] =>
  w.frames.flatMap(frame => (frame.t === 'deliver' ? [frame.message] : []))

const messagesTo = (target: string) =>
  core.events.since(0, 1000).filter(row => row.kind === 'message' && row.target === target)

/** Queue items held for a seat; the fixture's same-`workingOn` registration notices are left out. */
const ownerQueue = () =>
  core.events
    .humanQueue()
    .filter(item => item.meta.forwarded_for !== undefined)
    .map(item => [item.from, item.text, item.meta.forwarded_for])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-steward-'))
  process.env.AGENT_CHAT_HOME = dir
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ seatStewards: { [SEAT]: STEWARD } }))
  core = new BrokerCore((conn, message) => void conn.write(JSON.stringify({ t: 'deliver', message })), {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
    isSeat: name => [SEAT, STEWARD, UNMAPPED].includes(name),
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

describe('mail for a non-resident seat', () => {
  // Catches: forwarding a parked seat's mail to its steward, waking a seat that cannot act on it.
  it("queues a peer's message for a dark mapped seat for the owner, not the steward, and says so", () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    const result = send(sender, SEAT, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, recipients: ['human'] })
    expect(result.reason).toContain('owner queue')
    expect(ownerQueue()).toEqual([['rev-one', `[for ${SEAT}] Merged: #42`, SEAT]])
    expect(core.events.humanQueue().map(item => item.msgId)).toContain(result.msgId)
    expect(pushed(steward)).toEqual([])
    expect(messagesTo(STEWARD)).toEqual([])
    expect(messagesTo(SEAT)).toEqual([])
  })

  // Catches: the human path (Shepherd notices sent as the human) still waking the steward.
  it('queues a human send to a dark mapped seat for the owner, not the steward', () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    const human = wire()
    vi.setSystemTime(T0 + MINUTE)

    server.handleMessage(human.conn, { t: 'human_send', to: SEAT, text: 'Shepherd digest' })

    expect(human.frames.at(-1)).toMatchObject({ t: 'send_result', ok: true, recipients: ['human'] })
    expect(ownerQueue()).toEqual([['human', `[for ${SEAT}] Shepherd digest`, SEAT]])
    expect(pushed(steward)).toEqual([])
    expect(messagesTo(SEAT)).toEqual([])
  })

  // Catches: a watchdog wake for a seat it is resuming diverted to the owner queue.
  it("holds a watchdog wake for a dark mapped seat in the seat's own hold and pushes it on register", () => {
    goDark(SEAT)
    const human = wire()
    vi.setSystemTime(T0 + MINUTE)

    server.handleMessage(human.conn, { t: 'human_send', to: SEAT, text: 'Wake up', source: 'watchdog' })

    expect(human.frames.at(-1)).toMatchObject({ t: 'send_result', ok: true, held: true, recipients: [SEAT] })
    expect(ownerQueue()).toEqual([])
    vi.setSystemTime(T0 + 2 * MINUTE)
    expect(pushed(join(SEAT)).map(m => m.text)).toEqual(['Wake up'])
  })

  // Catches: queueing whenever the map names the target, connected or not.
  it('delivers to a mapped seat that has an active session', () => {
    const seat = join(SEAT)
    const steward = join(STEWARD)
    const sender = join('rev-one')

    const result = send(sender, SEAT, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, recipients: [SEAT] })
    expect(pushed(seat).map(m => m.text)).toEqual(['Merged: #42'])
    expect(pushed(steward)).toEqual([])
    expect(ownerQueue()).toEqual([])
  })

  // Catches: queueing a seat the map does not name for the owner.
  it('keeps the dark-seat hold for a seat the map does not name', () => {
    goDark(UNMAPPED)
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    const result = send(sender, UNMAPPED, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [UNMAPPED] })
    expect(messagesTo(UNMAPPED).map(row => row.meta.held)).toEqual([SEAT_HOLD_MARK])
    expect(ownerQueue()).toEqual([])
  })

  // Catches: dropping the reply reference on the queued message.
  it('keeps the reply reference on a queued message', () => {
    goDark(SEAT)
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    send(sender, SEAT, 'Merged: #42', 'msg-earlier')

    expect(messagesTo('human').map(row => row.ref)).toEqual(['msg-earlier'])
  })

  // Catches: a bare string `seatStewards` read as a steward for every unrouted name.
  it('ignores and logs a seatStewards value that is not a map', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ seatStewards: STEWARD }))
    const sender = join('rev-one')

    const result = send(sender, 'no-such-agent', 'Merged: #42')

    expect(result).toMatchObject({ ok: false })
    expect(ownerQueue()).toEqual([])
    const log = fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')
    expect(log).toContain('"config_invalid","key":"seatStewards"')
  })

  // Catches: the steward's own send to its dark seat queued for the owner.
  it("keeps the seat's hold for a message the steward sends to its own dark seat", () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    vi.setSystemTime(T0 + MINUTE)

    const result = send(steward, SEAT, 'Picking this up')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [SEAT] })
    expect(messagesTo(SEAT).map(row => row.meta.held)).toEqual([SEAT_HOLD_MARK])
    expect(ownerQueue()).toEqual([])
  })
})
