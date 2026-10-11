import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { ToolHandler } from '../server/tools.js'

/**
 * CC-168: a follow-up sent as part of an experiment records the experiment, arm and
 * follow-up kind on every message row it writes, so the session-origin miner can
 * count follow-ups per arm from row meta alone. Every name here is synthetic.
 */

const SEAT = 'seat-hub'
const TAGS = { experiment_id: 'E3', experiment_arm: 'warm-follow-up', followup_kind: 'fix' }
const EXTRAS = { experiment: { id: 'E3', arm: 'warm-follow-up' }, followupKind: 'fix' as const }

type SendResult = Extract<ServerMessage, { t: 'send_result' }>

let dir: string
let core: BrokerCore
let server: SocketServer

function join(name: string): { conn: Conn; frames: ServerMessage[] } {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  server.handleMessage(conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1 })
  return { conn, frames }
}

function send(
  from: { conn: Conn; frames: ServerMessage[] },
  frame: Omit<Extract<ClientMessage, { t: 'send' }>, 't'>,
) {
  server.handleMessage(from.conn, { t: 'send', ...frame })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const messageRows = () => core.events.history(1000).filter(item => item.kind === 'message')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-send-followup-'))
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

describe('a follow-up send records its experiment and kind', () => {
  it('a directed send records followup_kind and the experiment on the message row', () => {
    const coord = join('coord')
    join('worker-a')

    const result = send(coord, { to: 'worker-a', text: 'CI is red, fix it', ...EXTRAS })

    expect(result.ok).toBe(true)
    expect(messageRows()).toEqual([expect.objectContaining({ meta: expect.objectContaining(TAGS) })])
  })

  it("a multicast records them on every recipient's row", () => {
    const coord = join('coord')
    join('worker-a')
    join('worker-b')

    send(coord, { to: ['worker-a', 'worker-b'], text: 'rebase on main', ...EXTRAS })

    const rows = messageRows()
    expect(rows.map(r => r.meta?.target).sort()).toEqual(['worker-a', 'worker-b'])
    for (const row of rows) expect(row.meta).toMatchObject(TAGS)
  })

  it('a tag send records them beside the tag', () => {
    const coord = join('coord')
    const worker = join('worker-a')
    server.handleMessage(worker.conn, { t: 'tag', add: ['owner:src'] })

    send(coord, { toTag: 'owner:src', text: 'review this', ...EXTRAS })

    expect(messageRows()[0]?.meta).toMatchObject({ ...TAGS, tag: 'owner:src' })
  })

  it('a message held for a dark seat keeps them', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const seat = join(SEAT)
    core.drop(seat.conn)

    const result = send(join('coord'), { to: SEAT, text: 'extend the scope', ...EXTRAS })

    expect(result).toMatchObject({ ok: true, held: true })
    expect(messageRows()[0]?.meta).toMatchObject({ ...TAGS, held: 'seat_dark' })
  })

  it('an ordinary send writes no experiment fields', () => {
    const coord = join('coord')
    join('worker-a')

    send(coord, { to: 'worker-a', text: 'hello' })

    expect(messageRows()[0]?.meta).not.toHaveProperty('followup_kind')
    expect(messageRows()[0]?.meta).not.toHaveProperty('experiment_id')
  })

  it('the broker refuses a frame with an unknown follow-up kind and writes nothing', () => {
    const coord = join('coord')
    join('worker-a')

    const frame = { to: 'worker-a', text: 'hi', followupKind: 'nudge' } as unknown as Parameters<
      typeof send
    >[1]
    const result = send(coord, frame)

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/followupKind must be one of/) })
    expect(messageRows()).toHaveLength(0)
  })
})

describe('chat_send follow-up arguments', () => {
  const recording = () => {
    const sent: ClientMessage[] = []
    const reply = { t: 'send_result', ok: true, msgId: 'm1', recipients: ['worker-a'] } as ServerMessage
    const broker = {
      request: async (message: ClientMessage) => {
        sent.push(message)
        return reply
      },
    } as unknown as BrokerClient
    return { handler: new ToolHandler(broker, undefined, 'coord'), sent }
  }

  it('chat_send refuses an unknown follow-up kind', async () => {
    const { handler, sent } = recording()

    await expect(
      handler.handle('chat_send', { to: 'worker-a', text: 'hi', followup_kind: 'nudge' }),
    ).rejects.toThrow(/followup_kind must be one of: fix, rebase, extension, review/)
    expect(sent).toHaveLength(0)
  })

  it('puts the experiment and follow-up kind on the send frame', async () => {
    const { handler, sent } = recording()

    await handler.handle('chat_send', {
      to: 'worker-a',
      text: 'hi',
      experiment: { id: 'E3', arm: 'warm-follow-up' },
      followup_kind: 'fix',
    })

    expect(sent[0]).toMatchObject({ t: 'send', ...EXTRAS })
  })
})
