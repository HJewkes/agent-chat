import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { DeliveredMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1140: an open chat_ask to the human survives a broker restart, and its asker
 * is pushed the answer once. The broker restarts in process over the same events.db.
 * Every name and message here is synthetic.
 */

const ASKER = 'asker'
const SEAT = 'seat-hub'

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

let dir: string
let core: BrokerCore
let server: SocketServer

function boot(): void {
  core = new BrokerCore((conn, message) => void conn.write(JSON.stringify({ t: 'deliver', message })), {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
    isSeat: name => name === SEAT,
  })
  server = new SocketServer(core)
}

function shutdown(): void {
  server.close()
  core.close()
}

/** A clean stop drops each connection first; an unclean one leaves the registrations open. */
function restart(open: Wire[], clean: boolean): void {
  if (clean) for (const w of open) core.drop(w.conn)
  shutdown()
  boot()
}

function join(name: string, sessionId?: string): Wire {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  const msg = { t: 'register' as const, name, workingOn: 'testing', cwd: '/tmp', pid: 1 }
  server.handleMessage(conn, sessionId === undefined ? msg : { ...msg, sessionId })
  return { conn, frames }
}

function ask(from: Wire, text: string): string {
  server.handleMessage(from.conn, { t: 'ask', text })
  const result = from.frames.filter(f => f.t === 'send_result').at(-1) as Extract<
    ServerMessage,
    { t: 'send_result' }
  >
  if (!result.ok || result.msgId === undefined) throw new Error(`ask refused: ${result.reason}`)
  return result.msgId
}

const answer = (msgId: string, text: string): void => {
  expect(core.answer(msgId, text, 'cli').ok).toBe(true)
}

const pushed = (w: Wire): DeliveredMessage[] =>
  w.frames.flatMap(frame => (frame.t === 'deliver' ? [frame.message] : []))

const answersTo = (w: Wire, msgId: string): DeliveredMessage[] => pushed(w).filter(m => m.inReplyTo === msgId)

const openIds = (): string[] => core.events.humanQueue().map(item => item.msgId)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ask-restart-'))
  boot()
})

afterEach(() => {
  shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.each([
  ['clean', true],
  ['unclean', false],
])('an open ask across a %s restart', (_shape, clean) => {
  it('stays in the human queue under the same msg_id', () => {
    const asker = join(ASKER)
    const msgId = ask(asker, 'which branch?')

    restart([asker], clean)

    expect(openIds()).toContain(msgId)
  })

  it('pushes an answer given after the asker reconnects, replying to the original msg_id', () => {
    const before = join(ASKER)
    const msgId = ask(before, 'which branch?')
    restart([before], clean)

    const after = join(ASKER)
    answer(msgId, 'main')

    expect(answersTo(after, msgId).map(m => m.text)).toEqual(['main'])
    expect(openIds()).not.toContain(msgId)
  })

  it('pushes an answer given while the asker was disconnected once, when it registers', () => {
    const before = join(ASKER)
    const msgId = ask(before, 'which branch?')
    restart([before], clean)

    answer(msgId, 'main')
    const after = join(ASKER)

    expect(answersTo(after, msgId).map(m => m.text)).toEqual(['main'])
  })
})

describe('missed answers on re-register', () => {
  it('a second registration after the push gets no duplicate', () => {
    const before = join(ASKER)
    const msgId = ask(before, 'which branch?')
    restart([before], true)
    answer(msgId, 'main')
    const first = join(ASKER)
    core.drop(first.conn)

    const second = join(ASKER)

    expect(answersTo(first, msgId)).toHaveLength(1)
    expect(answersTo(second, msgId)).toEqual([])
  })

  it('does not re-push an answer the asker already received live before the restart', () => {
    const before = join(ASKER)
    const msgId = ask(before, 'which branch?')
    answer(msgId, 'main')
    restart([before], false)

    const after = join(ASKER)

    expect(answersTo(before, msgId)).toHaveLength(1)
    expect(answersTo(after, msgId)).toEqual([])
  })

  it('gives nothing to a different session reusing the dead asker name', () => {
    const before = join(ASKER, 'session-one')
    const msgId = ask(before, 'which branch?')
    restart([before], true)
    answer(msgId, 'main')

    const stranger = join(ASKER, 'session-two')

    expect(answersTo(stranger, msgId)).toEqual([])
  })

  it('pushes the same asking session its answer when it comes back under its session id', () => {
    const before = join(ASKER, 'session-one')
    const msgId = ask(before, 'which branch?')
    restart([before], true)
    answer(msgId, 'main')

    const after = join(ASKER, 'session-one')

    expect(answersTo(after, msgId).map(m => m.text)).toEqual(['main'])
  })

  it('pushes a seat registering out of the dark each answer exactly once', () => {
    const before = join(SEAT)
    const msgId = ask(before, 'which branch?')
    restart([before], true)
    answer(msgId, 'main')

    const after = join(SEAT)

    expect(answersTo(after, msgId).map(m => m.text)).toEqual(['main'])
  })
})
