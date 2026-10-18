import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1454: a client whose `send_result` timed out retries the same send with the
 * same nonce, and the broker answers from its cache instead of delivering twice.
 * Every name and message here is synthetic.
 */

const SEAT = 'seat-x'
const NONCE = 'k'.repeat(32)

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

function send(from: Wire, frame: Omit<Extract<ClientMessage, { t: 'send' }>, 't'>): SendResult {
  server.handleMessage(from.conn, { t: 'send', ...frame })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const deliveries = (w: Wire): number => w.frames.filter(frame => frame.t === 'deliver').length

const messageRows = (): number => core.events.since(0, 1000).filter(row => row.kind === 'message').length

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-send-idem-'))
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
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a keyed send retried with the same nonce', () => {
  it('delivers once and answers the retry with the first msg_id, marked deduped', () => {
    const scout = join('scout')
    const peer = join('agent-x')

    const first = send(scout, { to: 'agent-x', text: 'status?', nonce: NONCE })
    const retry = send(scout, { to: 'agent-x', text: 'status?', nonce: NONCE })

    expect(first).toMatchObject({ ok: true })
    expect(first.deduped).toBeUndefined()
    expect(retry).toMatchObject({ ok: true, msgId: first.msgId, deduped: true })
    expect(deliveries(peer)).toBe(1)
    expect(messageRows()).toBe(1)
  })

  it('holds a send to a dark seat once', () => {
    core.drop(join(SEAT).conn)
    const scout = join('scout')

    const first = send(scout, { to: SEAT, text: 'report', nonce: NONCE })
    const retry = send(scout, { to: SEAT, text: 'report', nonce: NONCE })

    expect(first).toMatchObject({ ok: true, held: true })
    expect(retry).toMatchObject({ ok: true, held: true, msgId: first.msgId, deduped: true })
    expect(messageRows()).toBe(1)
  })

  it('fans a multicast out once', () => {
    const scout = join('scout')
    const peers = [join('agent-x'), join('agent-y')]

    send(scout, { to: ['agent-x', 'agent-y'], text: 'sync', nonce: NONCE })
    const retry = send(scout, { to: ['agent-x', 'agent-y'], text: 'sync', nonce: NONCE })

    expect(retry).toMatchObject({ ok: true, deduped: true })
    expect(peers.map(deliveries)).toEqual([1, 1])
    expect(messageRows()).toBe(2)
  })

  it('refuses the same nonce on a different message and does not send it', () => {
    const scout = join('scout')
    const peer = join('agent-x')
    send(scout, { to: 'agent-x', text: 'first', nonce: NONCE })

    const other = send(scout, { to: 'agent-x', text: 'second', nonce: NONCE })

    expect(other).toMatchObject({ ok: false, reason: expect.stringContaining('different request') })
    expect(deliveries(peer)).toBe(1)
  })

  it('sends again after a refusal, since nothing happened the first time', () => {
    const scout = join('scout')

    expect(send(scout, { to: 'agent-x', text: 'hi', nonce: NONCE })).toMatchObject({ ok: false })
    const peer = join('agent-x')
    const retry = send(scout, { to: 'agent-x', text: 'hi', nonce: NONCE })

    expect(retry).toMatchObject({ ok: true })
    expect(retry.deduped).toBeUndefined()
    expect(deliveries(peer)).toBe(1)
  })

  it('refuses a malformed nonce before sending', () => {
    const scout = join('scout')
    const peer = join('agent-x')

    const result = send(scout, { to: 'agent-x', text: 'hi', nonce: 'short' })

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('nonce') })
    expect(deliveries(peer)).toBe(0)
  })
})

describe('the requester is part of the key', () => {
  it("delivers another session's send with the same nonce as its own message", () => {
    const scout = join('scout')
    const other = join('agent-y')
    const peer = join('agent-x')
    const first = send(scout, { to: 'agent-x', text: 'same', nonce: NONCE })

    const theirs = send(other, { to: 'agent-x', text: 'same', nonce: NONCE })

    expect(theirs).toMatchObject({ ok: true })
    expect(theirs.deduped).toBeUndefined()
    expect(theirs.msgId).not.toBe(first.msgId)
    expect(deliveries(peer)).toBe(2)
  })
})

describe('a send without a nonce', () => {
  it('delivers every time and carries no deduped field', () => {
    const scout = join('scout')
    const peer = join('agent-x')

    const results = [
      send(scout, { to: 'agent-x', text: 'ping' }),
      send(scout, { to: 'agent-x', text: 'ping' }),
    ]

    expect(results.map(r => 'deduped' in r)).toEqual([false, false])
    expect(deliveries(peer)).toBe(2)
    expect(messageRows()).toBe(2)
  })
})
