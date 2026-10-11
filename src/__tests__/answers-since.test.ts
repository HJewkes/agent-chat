import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { MAX_OPEN_SERVICE_ASKS_PER_CONNECTION, MAX_OPEN_SERVICE_QUESTIONS } from '../broker/service-ask.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-169 slice b: a service process reads back what the human did with its
 * asks, by msg_id cursor, from a connection that never registers.
 */

interface Wire {
  conn: Conn
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
}

type AskResult = Extract<ServerMessage, { t: 'service_ask_result' }>
type AnswersResult = Extract<ServerMessage, { t: 'answers_since_result' }>

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-answers-since-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

function setup(): { core: BrokerCore; wire: () => Wire } {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
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
    return { conn, frames, send: msg => emitter.emit('data', JSON.stringify(msg) + '\n') }
  }
  return { core, wire }
}

function lastOf<T extends ServerMessage['t']>(caller: Wire, t: T): Extract<ServerMessage, { t: T }> {
  return caller.frames.filter((f): f is Extract<ServerMessage, { t: T }> => f.t === t).at(-1)!
}

function serviceAsk(caller: Wire, as = 'factory-t', text = 'Approve gate g-1?'): AskResult {
  caller.send({ t: 'service_ask', as, text })
  return lastOf(caller, 'service_ask_result')
}

function answersSince(caller: Wire, name: string, after?: string, limit = 50): AnswersResult {
  caller.send({ t: 'answers_since', name, limit, ...(after !== undefined ? { after } : {}) })
  return lastOf(caller, 'answers_since_result')
}

describe('answers_since for a service label', () => {
  // Mutation caught: leaving out the ref-to-question join.
  it('returns the one answer to an ask, with the human words, and a refused second answer adds none', () => {
    const { wire } = setup()
    const service = wire()
    const human = wire()
    const { msgId: questionId } = serviceAsk(service)

    human.send({ t: 'answer', msgId: questionId!, text: 'approve', channel: 'cli' })
    human.send({ t: 'answer', msgId: questionId!, text: 'decline' })
    const read = answersSince(wire(), 'factory-t', questionId)

    expect(lastOf(human, 'answer_result')).toMatchObject({ ok: false })
    expect(read.error).toBeUndefined()
    expect(read.answers).toHaveLength(1)
    expect(read.answers[0]).toMatchObject({
      questionId,
      outcome: 'answered',
      text: 'approve',
      by: 'human',
      channel: 'cli',
    })
    expect(read.next).toBe(read.answers[0]!.msgId)
  })

  // Mutation caught: leaving `resolution` out of the kinds.
  it('returns a dismissal as one dismissed row', () => {
    const { wire } = setup()
    const { msgId: questionId } = serviceAsk(wire())

    wire().send({ t: 'dismiss', msgId: questionId! })
    const read = answersSince(wire(), 'factory-t')

    expect(read.answers).toEqual([
      expect.objectContaining({ questionId, outcome: 'dismissed', text: 'dismissed', by: 'human' }),
    ])
  })

  it('returns rows in id order across several asks, from row 0 when after is absent', () => {
    const { wire } = setup()
    const human = wire()
    const first = serviceAsk(wire(), 'factory-t', 'gate 1?').msgId!
    const second = serviceAsk(wire(), 'factory-t', 'gate 2?').msgId!

    human.send({ t: 'answer', msgId: second, text: 'two' })
    human.send({ t: 'answer', msgId: first, text: 'one' })
    const read = answersSince(wire(), 'factory-t')

    expect(read.answers.map(a => [a.questionId, a.text])).toEqual([
      [second, 'two'],
      [first, 'one'],
    ])
  })

  // Mutation caught: falling back to row 0 on an unknown id.
  it('returns nothing new after next, and an error with no rows for an unknown after', () => {
    const { wire } = setup()
    const reader = wire()
    const { msgId: questionId } = serviceAsk(wire())
    wire().send({ t: 'answer', msgId: questionId!, text: 'approve' })

    const first = answersSince(reader, 'factory-t', questionId)
    const again = answersSince(reader, 'factory-t', first.next)
    const unknown = answersSince(reader, 'factory-t', 'no-such-msg')

    expect(first.answers).toHaveLength(1)
    expect(again).toMatchObject({ answers: [] })
    expect(again.next).toBeUndefined()
    expect(unknown.answers).toEqual([])
    expect(unknown.error).toEqual(expect.stringContaining('no-such-msg'))
  })

  it('clamps limit to 50 and pages on with next', () => {
    const { wire } = setup()
    const human = wire()
    const service = wire()
    for (let n = 0; n < 3 * MAX_OPEN_SERVICE_QUESTIONS; n++) {
      const { msgId } = serviceAsk(service, 'factory-t', `gate ${n}?`)
      human.send({ t: 'answer', msgId: msgId!, text: `answer ${n}` })
    }
    const reader = wire()

    const page = answersSince(reader, 'factory-t', undefined, 1000)
    const rest = answersSince(reader, 'factory-t', page.next, 1000)

    expect(page.answers).toHaveLength(50)
    expect(page.next).toBe(page.answers.at(-1)!.msgId)
    expect(rest.answers.map(a => a.text)).toEqual(Array.from({ length: 10 }, (_, n) => `answer ${50 + n}`))
  })

  // Mutation caught: dropping the `source = 'service'` filter.
  it("never returns answers to a peer session's ordinary ask under that name", () => {
    const { core, wire } = setup()
    const peer = wire()
    peer.send({ t: 'register', name: 'peer', workingOn: 'testing', cwd: '/tmp', pid: 1 })
    peer.send({ t: 'ask', text: 'Which way?' })
    const asked = core.events.humanQueue().find(i => i.from === 'peer')!

    wire().send({ t: 'answer', msgId: asked.msgId, text: 'left' })
    const read = answersSince(wire(), 'peer')

    expect(read.answers).toEqual([])
  })

  it('writes nothing to the log', () => {
    const { core, wire } = setup()
    const { msgId: questionId } = serviceAsk(wire())
    const before = core.events.latestId()

    answersSince(wire(), 'factory-t', questionId)

    expect(core.events.latestId()).toBe(before)
  })
})

describe('the per-connection cap on open service asks', () => {
  it(`refuses the ${MAX_OPEN_SERVICE_ASKS_PER_CONNECTION + 1}st open ask from one connection across labels`, () => {
    const { wire } = setup()
    const caller = wire()

    const results = Array.from({ length: MAX_OPEN_SERVICE_ASKS_PER_CONNECTION }, (_, n) =>
      serviceAsk(caller, `svc-${n}`),
    )
    const over = serviceAsk(caller, 'svc-over')

    expect(MAX_OPEN_SERVICE_ASKS_PER_CONNECTION).toBe(50)
    expect(results.every(r => r.ok)).toBe(true)
    expect(over).toMatchObject({ ok: false, reason: expect.stringContaining('connection') })
    expect(serviceAsk(wire(), 'svc-over')).toMatchObject({ ok: true })
  })

  it('frees a slot when one of the connection asks is closed', () => {
    const { wire } = setup()
    const caller = wire()
    const ids = Array.from(
      { length: MAX_OPEN_SERVICE_ASKS_PER_CONNECTION },
      (_, n) => serviceAsk(caller, `svc-${n}`).msgId!,
    )

    wire().send({ t: 'dismiss', msgId: ids[0]! })

    expect(serviceAsk(caller, 'svc-next')).toMatchObject({ ok: true })
  })
})
