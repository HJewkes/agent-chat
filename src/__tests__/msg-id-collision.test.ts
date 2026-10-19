import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type net from 'node:net'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { batchOf } from '../broker/report-batch.js'
import { SocketServer } from '../broker/socket.js'
import { HUMAN, type DecisionCitation, type DeliveredMessage } from '../protocol.js'

/** CC-1187: an 8-hex msg_id that repeats a closed item's id would be born closed. */

const uuids = vi.hoisted(() => ({ queue: [] as string[] }))

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => uuids.queue.shift() ?? actual.randomUUID() }
})

const uuidStarting = (prefix: string): string => `${prefix}-0000-4000-8000-000000000000`

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-msg-id-'))
  process.env.AGENT_CHAT_HOME = dir
  uuids.queue = []
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('minting a msg_id the log already holds', () => {
  it('keeps a new open item in the queue when its first random id repeats a resolved one', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    uuids.queue.push(uuidStarting('aaaaaaaa'))
    const closed = log.append({ kind: 'message', actor: 'agent-chat', target: 'human', body: 'closed' })
    log.append({ kind: 'resolution', actor: 'human', ref: closed.msgId, body: 'dismissed' })

    uuids.queue.push(uuidStarting('aaaaaaaa'), uuidStarting('bbbbbbbb'))
    const open = log.append({ kind: 'message', actor: 'agent-chat', target: 'human', body: 'open' })

    expect(open.msgId).toBe('bbbbbbbb')
    expect(log.humanQueue().map(item => item.msgId)).toEqual(['bbbbbbbb'])
  })

  it('does not mint an id that a resolution already references', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    log.append({ kind: 'resolution', actor: 'human', ref: 'cccccccc', body: 'dismissed' })

    uuids.queue.push(uuidStarting('cccccccc'), uuidStarting('dddddddd'))
    const open = log.append({ kind: 'message', actor: 'agent-chat', target: 'human', body: 'open' })

    expect(open.msgId).toBe('dddddddd')
    expect(log.humanQueue()).toHaveLength(1)
  })

  it('keeps a caller-supplied msg_id as given', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    log.append({ kind: 'message', actor: 'agent-chat', target: 'human', msgId: 'eeeeeeee', body: 'first' })

    const second = log.append({ kind: 'message', actor: 'peer-a', target: 'peer-b', msgId: 'eeeeeeee' })

    expect(second.msgId).toBe('eeeeeeee')
  })
})

/** CC-1188: every path that needs an id before, or without, an append mints it through the log. */
describe('an explicit-id path whose first draw repeats an open human item', () => {
  const OPEN = 'aaaaaaaa'
  const CITATION: DecisionCitation = {
    precedent: 'transcript session abc tool_use toolu_1: "Keep going while ready work exists" (2026-09-20)',
    class: 'session_control',
    basis: 'precedent',
    reversible: 'the asker stops at its next boundary',
  }

  function makeCore(): { core: BrokerCore; delivered: DeliveredMessage[] } {
    const delivered: DeliveredMessage[] = []
    const core = new BrokerCore((_conn, message) => void delivered.push(message), {
      events: new EventLog(path.join(dir, 'events.db')),
      registry: new Registry<Conn>(),
    })
    uuids.queue.push(uuidStarting(OPEN))
    core.append({ kind: 'message', actor: 'agent-chat', target: HUMAN, body: 'open item' })
    return { core, delivered }
  }

  function join(core: BrokerCore, name: string): Conn {
    const conn = { write: () => true } as unknown as net.Socket
    core.register(conn, {
      t: 'register',
      name,
      workingOn: 'testing',
      cwd: '/tmp',
      pid: 1,
      sessionId: `s-${name}`,
    })
    return conn
  }

  const collideNext = (): void => void uuids.queue.push(uuidStarting(OPEN), uuidStarting('bbbbbbbb'))

  const loggedIds = (core: BrokerCore, kind: string): (string | null)[] =>
    core.events
      .since(0, 1000)
      .filter(row => row.kind === kind && row.actor !== 'agent-chat')
      .map(row => row.msgId)

  const openItems = (core: BrokerCore): string[] => core.events.humanQueue().map(item => item.msgId)

  it('skips an id held as msg_id and an id held only as ref', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    uuids.queue.push(uuidStarting(OPEN))
    log.append({ kind: 'message', actor: 'agent-chat', target: HUMAN, body: 'open item' })
    log.append({ kind: 'resolution', actor: HUMAN, ref: 'cccccccc', body: 'dismissed' })
    uuids.queue.push(uuidStarting(OPEN), uuidStarting('cccccccc'), uuidStarting('dddddddd'))

    expect(log.mintMsgId()).toBe('dddddddd')
  })

  // Mutation caught: queueForSeat drawing its own id instead of the logged row's.
  it('gives a message queued for a non-resident seat the second draw', () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ seatStewards: { 'seat-pc': 'seat-tc' } }),
    )
    const { core } = makeCore()
    collideNext()

    const queued = core.queueForSeat(HUMAN, 'seat-pc', 'Merged: #42')

    expect(queued).toBe('bbbbbbbb')
    expect(openItems(core)).toEqual(expect.arrayContaining([OPEN, 'bbbbbbbb']))
  })

  // Mutation caught: the delivered answer built with its own draw, so it and the logged row diverge.
  it('logs and delivers a human answer under the second draw', () => {
    const { core, delivered } = makeCore()
    join(core, 'asker')
    const question = core.append({ kind: 'question', actor: 'asker', target: HUMAN, body: 'continue?' }).msgId
    collideNext()

    expect(core.answer(question, 'yes', 'cli')).toEqual({ ok: true })

    expect(loggedIds(core, 'answer')).toEqual(['bbbbbbbb'])
    expect(delivered.map(m => m.msgId)).toEqual(['bbbbbbbb'])
    expect(openItems(core)).toContain(OPEN)
  })

  // Mutation caught: decide drawing its own id again.
  it('logs and delivers a decision under the second draw', () => {
    const { core, delivered } = makeCore()
    join(core, 'asker')
    const question = core.append({ kind: 'question', actor: 'asker', target: HUMAN, body: 'continue?' }).msgId
    collideNext()

    expect(core.decide('decider', question, 'yes, continue', CITATION)).toEqual({ ok: true })

    expect(loggedIds(core, 'decided')).toEqual(['bbbbbbbb'])
    expect(delivered.map(m => m.msgId)).toEqual(['bbbbbbbb'])
    expect(openItems(core)).toContain(OPEN)
  })

  // Mutation caught: endorse drawing its own id for the delivered message again.
  it('logs and delivers an endorsed message under the second draw', () => {
    const { core, delivered } = makeCore()
    join(core, 'alpha')
    const beta = join(core, 'beta')
    const meta = { recipient: 'beta', recipient_agent_id: core.registry.entryFor(beta)!.agentId! }
    const request = core.append({
      kind: 'endorse_request',
      actor: 'alpha',
      target: HUMAN,
      body: 'ship',
      meta,
    })
    uuids.queue.push(uuidStarting('cccccccc'))
    collideNext()

    expect(core.endorse(request.msgId, { text: 'ship', to: 'beta' })).toEqual({ ok: true })

    expect(delivered.map(m => m.msgId)).toEqual(['bbbbbbbb'])
    expect(loggedIds(core, 'message')).toEqual(['bbbbbbbb'])
    expect(openItems(core)).toContain(OPEN)
  })

  // Mutation caught: handleHumanSend drawing its id before it appends.
  it('logs and delivers a human send to a live peer under the second draw', () => {
    const { core, delivered } = makeCore()
    const server = new SocketServer(core)
    join(core, 'beta')
    const cli = { write: () => true } as unknown as Conn
    collideNext()

    server.handleMessage(cli, { t: 'human_send', to: 'beta', text: 'hello' })

    expect(loggedIds(core, 'message')).toEqual(['bbbbbbbb'])
    expect(delivered.map(m => m.msgId)).toEqual(['bbbbbbbb'])
    expect(openItems(core)).toContain(OPEN)
    server.close()
  })

  // Mutation caught: batchOf drawing its own id instead of the injected mint.
  it('names a report batch with the injected mint', () => {
    const report = (msgId: string): DeliveredMessage => ({ msgId, from: 'w-a', text: 'Status: DONE', at: 0 })

    expect(batchOf([report('r1'), report('r2')], () => 'bbbbbbbb').msgId).toBe('bbbbbbbb')
  })
})
