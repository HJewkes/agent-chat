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
 * CC-966: a message to a non-resident seat goes to the steward `seatStewards` names for it,
 * instead of waiting in a hold nobody reads. Every name, time and message here is synthetic.
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

describe('the seat steward forward', () => {
  // Catches: holding for the dark seat before consulting its steward.
  it('delivers a message for a dark mapped seat to its connected steward, marked as for the seat', () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    const result = send(sender, SEAT, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, recipients: [STEWARD] })
    expect(result.held).toBeUndefined()
    expect(pushed(steward).map(m => [m.from, m.text, m.msgId])).toEqual([
      ['rev-one', `[for ${SEAT}] Merged: #42`, result.msgId],
    ])
    expect(messagesTo(STEWARD).map(row => row.meta)).toEqual([{ forwarded_for: SEAT }])
    expect(messagesTo(SEAT)).toEqual([])
  })

  // Catches: holding a forwarded message for the dark seat instead of for its steward.
  it('holds the message for the steward when the steward is dark too, and pushes it when it registers', () => {
    goDark(SEAT)
    goDark(STEWARD)
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    const result = send(sender, SEAT, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [STEWARD] })
    expect(messagesTo(SEAT)).toEqual([])
    expect(messagesTo(STEWARD).map(row => row.meta.held)).toEqual([SEAT_HOLD_MARK])
    vi.setSystemTime(T0 + 2 * MINUTE)
    const back = join(STEWARD)
    expect(pushed(back).map(m => m.text)).toEqual([`[for ${SEAT}] Merged: #42`])
  })

  // Catches: forwarding whenever the map names the target, connected or not.
  it('delivers to a mapped seat that has an active session, with no forward', () => {
    const seat = join(SEAT)
    const steward = join(STEWARD)
    const sender = join('rev-one')

    const result = send(sender, SEAT, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, recipients: [SEAT] })
    expect(pushed(seat).map(m => m.text)).toEqual(['Merged: #42'])
    expect(pushed(steward)).toEqual([])
  })

  // Catches: forwarding a seat the map does not name to some default steward.
  it('keeps the dark-seat hold for a seat the map does not name', () => {
    goDark(UNMAPPED)
    const steward = join(STEWARD)
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    const result = send(sender, UNMAPPED, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [UNMAPPED] })
    expect(messagesTo(UNMAPPED).map(row => row.meta.held)).toEqual([SEAT_HOLD_MARK])
    expect(pushed(steward)).toEqual([])
  })

  // Catches: dropping the reply reference, so the steward's answer starts a new thread.
  it('keeps the reply reference on a forwarded message', () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    send(sender, SEAT, 'Merged: #42', 'msg-earlier')

    expect(pushed(steward).map(m => m.inReplyTo)).toEqual(['msg-earlier'])
    expect(messagesTo(STEWARD).map(row => row.ref)).toEqual(['msg-earlier'])
  })

  // Catches: a peer's forward pushed live past the steward's do-not-disturb.
  it("logs a peer's forward to a steward in do-not-disturb without pushing it", () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    server.handleMessage(steward.conn, { t: 'status', status: 'working', dnd: true })
    const sender = join('rev-one')
    vi.setSystemTime(T0 + MINUTE)

    const result = send(sender, SEAT, 'Merged: #42')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [STEWARD] })
    expect(pushed(steward)).toEqual([])
    expect(messagesTo(STEWARD).map(row => [row.body, row.meta.forwarded_for])).toEqual([
      [`[for ${SEAT}] Merged: #42`, SEAT],
    ])
  })

  // Catches: a bare string `seatStewards` read as a steward for every unrouted name.
  it('ignores and logs a seatStewards value that is not a map', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ seatStewards: STEWARD }))
    const steward = join(STEWARD)
    const sender = join('rev-one')

    const result = send(sender, 'no-such-agent', 'Merged: #42')

    expect(result).toMatchObject({ ok: false })
    expect(pushed(steward)).toEqual([])
    const log = fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')
    expect(log).toContain('"config_invalid","key":"seatStewards"')
  })

  // Catches: the steward's own send to its dark seat handed back to the steward.
  it("keeps the seat's hold for a message the steward sends to its own dark seat", () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    vi.setSystemTime(T0 + MINUTE)

    const result = send(steward, SEAT, 'Picking this up')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [SEAT] })
    expect(messagesTo(SEAT).map(row => row.meta.held)).toEqual([SEAT_HOLD_MARK])
  })

  // Catches: the human path (watchdog, CLI) skipping the steward and holding for the seat.
  it('forwards a human send to a dark mapped seat to its steward', () => {
    goDark(SEAT)
    const steward = join(STEWARD)
    const human = wire()
    vi.setSystemTime(T0 + MINUTE)

    server.handleMessage(human.conn, { t: 'human_send', to: SEAT, text: 'Check the queue' })

    expect(human.frames.at(-1)).toMatchObject({ t: 'send_result', ok: true, recipients: [STEWARD] })
    expect(pushed(steward).map(m => m.text)).toEqual([`[for ${SEAT}] Check the queue`])
    expect(messagesTo(SEAT)).toEqual([])
  })
})
