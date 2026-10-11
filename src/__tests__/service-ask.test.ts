import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { MAX_OPEN_SERVICE_QUESTIONS } from '../broker/service-ask.js'
import type { ClientMessage, DecisionCitation, ServerMessage } from '../protocol.js'

/**
 * CC-169 slice a: a process that is not a session files a question for the
 * human under a label. Driven in-process against a real EventLog.
 */

interface Wire {
  conn: Conn
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
}

type AskResult = Extract<ServerMessage, { t: 'service_ask_result' }>

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-service-ask-'))
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

function registered(wire: () => Wire, name: string, sessionId?: string): Wire {
  const session = wire()
  session.send({
    t: 'register',
    name,
    workingOn: 'testing',
    cwd: '/tmp',
    pid: 1,
    ...(sessionId ? { sessionId } : {}),
  })
  return session
}

function serviceAsk(
  caller: Wire,
  frame: Partial<Extract<ClientMessage, { t: 'service_ask' }>> = {},
): AskResult {
  caller.send({ t: 'service_ask', as: 'factory-t', text: 'Approve gate g-1?', ...frame })
  return caller.frames.filter((f): f is AskResult => f.t === 'service_ask_result').at(-1)!
}

const questions = (core: BrokerCore) => core.events.humanQueue().filter(i => i.kind === 'question')

const CITATION: DecisionCitation = {
  precedent: 'transcript session abc tool_use toolu_1: "Keep going while ready work exists" (2026-09-20)',
  class: 'session_control',
  basis: 'precedent',
  reversible: 'the asker stops at its next boundary',
}

describe('a service process filing a question', () => {
  // Mutation caught: dropping `source: 'service'` from the meta.
  it('lands in the human queue under its label with source service and its shape', () => {
    const { core, wire } = setup()

    const result = serviceAsk(wire(), { options: ['approve', 'decline'], task: 'g-1' })

    expect(result).toMatchObject({ ok: true })
    const item = questions(core).find(i => i.msgId === result.msgId)
    expect(item).toMatchObject({ kind: 'question', from: 'factory-t', text: 'Approve gate g-1?' })
    expect(item?.meta).toMatchObject({ source: 'service', task: 'g-1' })
  })

  it('writes one question row targeted at the human, actor the label', () => {
    const { core, wire } = setup()

    const { msgId } = serviceAsk(wire())

    const rows = core.events.since(0, 1000).filter(r => r.msgId === msgId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'question',
      actor: 'factory-t',
      target: 'human',
      body: 'Approve gate g-1?',
    })
    expect(rows[0]!.meta).toEqual({ source: 'service' })
  })

  it('cannot be passed off as another source through the shape fields', () => {
    const { core, wire } = setup()
    const forged = { source: 'hook' } as unknown as Partial<Extract<ClientMessage, { t: 'service_ask' }>>

    const { msgId } = serviceAsk(wire(), forged)

    expect(questions(core).find(i => i.msgId === msgId)?.meta.source).toBe('service')
  })
})

describe('a service ask is refused', () => {
  // Mutation caught: removing the `isHuman` check.
  it('from a registered session, with a verdict_refused row and no question', () => {
    const { core, wire } = setup()
    const peer = registered(wire, 'peer')

    expect(serviceAsk(peer)).toMatchObject({ ok: false })

    expect(questions(core)).toHaveLength(0)
    expect(core.events.history(50).some(i => i.kind === 'verdict_refused' && i.from === 'peer')).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['uppercase', 'Factory'],
    ['spaced', 'factory t'],
    ['too long', 'a'.repeat(49)],
  ])('when the label is %s', (_case, as) => {
    const { core, wire } = setup()

    expect(serviceAsk(wire(), { as: as as string })).toMatchObject({ ok: false })
    expect(questions(core)).toHaveLength(0)
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['over the cap', 'x'.repeat(4001)],
  ])('when the text is %s', (_case, text) => {
    const { core, wire } = setup()

    expect(serviceAsk(wire(), { text })).toMatchObject({ ok: false })
    expect(questions(core)).toHaveLength(0)
  })

  // Mutation caught: dropping the `connFor` collision check.
  it('when the label is a live session name', () => {
    const { core, wire } = setup()
    registered(wire, 'factory-t')

    expect(serviceAsk(wire())).toMatchObject({ ok: false, reason: expect.stringContaining('session') })
    expect(questions(core)).toHaveLength(0)
  })

  it('when the label names a durable agent in the roster, even while it is offline', () => {
    const { core, wire } = setup()
    const session = registered(wire, 'factory-t', 'session-factory-t')
    session.conn.emit('close')

    expect(core.registry.connFor('factory-t')).toBeUndefined()
    expect(serviceAsk(wire())).toMatchObject({ ok: false })
    expect(questions(core)).toHaveLength(0)
  })

  // Mutation caught: reusing the session cap of 3.
  it(`past ${MAX_OPEN_SERVICE_QUESTIONS} open asks per label, and not before`, () => {
    const { wire } = setup()
    const caller = wire()

    const results = Array.from({ length: MAX_OPEN_SERVICE_QUESTIONS + 1 }, (_, n) =>
      serviceAsk(caller, { text: `gate ${n}?` }),
    )

    expect(MAX_OPEN_SERVICE_QUESTIONS).toBe(20)
    expect(results.slice(0, MAX_OPEN_SERVICE_QUESTIONS).every(r => r.ok)).toBe(true)
    expect(results.at(-1)).toMatchObject({ ok: false })
    expect(serviceAsk(caller, { as: 'other-label' })).toMatchObject({ ok: true })
  })
})

describe('the decider and a service ask', () => {
  // Mutation caught: removing the `source` clause from `undecidedQuestion`.
  it('gets not_decidable, and the question stays in the human queue', () => {
    const { core, wire } = setup()
    const decider = registered(wire, 'decider', 'session-decider')
    const agentId = core.registry.entryFor(decider.conn)!.agentId!
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ decider: { agentId } }))
    const { msgId } = serviceAsk(wire(), { text: 'Should I continue with the next ready task?' })

    decider.send({ t: 'decided', msgId: msgId!, text: 'Yes, continue.', ...CITATION })

    expect(decider.frames.filter(f => f.t === 'decided_result').at(-1)).toMatchObject({
      ok: false,
      code: 'not_decidable',
    })
    expect(questions(core).map(i => i.msgId)).toContain(msgId)
    expect(core.events.decidedQueue()).toEqual([])
  })
})
