import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { TELEPORT_GAP_MS } from '../broker/teleport-window.js'
import type { DeliveredMessage, ServerMessage } from '../protocol.js'

/**
 * CC-301: a send to a name that is not a seat, sent while it is mid-teleport, waits for
 * the successor instead of failing. Every name, time and message here is synthetic.
 */

const WORKER = 'impl-two'
const T0 = Date.parse('2026-09-29T14:46:00.000Z')
const MINUTE = 60_000

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

let dir: string
let core: BrokerCore
let server: SocketServer
let sessions = 0

const wire = (): Wire => {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  return { conn, frames }
}

function join(name: string, agentId?: string): Wire {
  sessions += 1
  const w = wire()
  server.handleMessage(w.conn, {
    t: 'register',
    name,
    workingOn: 'testing',
    cwd: '/tmp',
    pid: 100 + sessions,
    sessionId: `session-${sessions}`,
    ...(agentId === undefined ? {} : { agentId }),
  })
  return w
}

type SendResult = Extract<ServerMessage, { t: 'send_result' }>

function send(from: Wire, to: string, text: string): SendResult {
  server.handleMessage(from.conn, { t: 'send', to, text })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const pushed = (w: Wire): DeliveredMessage[] =>
  w.frames.flatMap(frame => (frame.t === 'deliver' ? [frame.message] : []))

const at = (ms: number): void => void vi.setSystemTime(ms)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0 - 35 * MINUTE)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-teleport-hold-'))
  core = new BrokerCore((conn, message) => void conn.write(JSON.stringify({ t: 'deliver', message })), {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
    isSeat: () => false,
  })
  server = new SocketServer(core)
})

afterEach(() => {
  server.close()
  core.close()
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** The worker writes its handoff and stands down, as `teleport` does, then its connection drops at `T0`. */
function teleports(predecessor: Wire): string {
  const agentId = core.registry.entryFor(predecessor.conn)?.agentId as string
  at(T0)
  const { msgId: successor } = core.append({
    kind: 'agent_spawned',
    actor: WORKER,
    target: WORKER,
    body: 'testing',
    meta: { name: WORKER },
  })
  core.append({ kind: 'agent_handoff', actor: WORKER, ref: agentId, body: 'h', meta: { successor } })
  core.append({ kind: 'agent_stood_down', actor: WORKER, ref: agentId })
  core.drop(predecessor.conn)
  return successor
}

describe('a send to a non-seat name mid-teleport', () => {
  it('holds the report and delivers it to the successor when it registers', () => {
    const successorId = teleports(join(WORKER))
    at(T0 + MINUTE)

    const result = send(join('rev-one'), WORKER, 'Verdict: MERGE')

    expect(result).toMatchObject({ ok: true, held: true, recipients: [WORKER] })
    expect(result.reason).toContain('has not been delivered or read')
    at(T0 + 2 * MINUTE)
    const successor = join(WORKER, successorId)
    expect(successor.frames[0]).toMatchObject({ t: 'register_result', ok: true })
    expect(pushed(successor).map(m => [m.from, m.text, m.msgId])).toEqual([
      ['rev-one', 'Verdict: MERGE', result.msgId],
    ])
  })

  it('pushes the held report once: a later register of the name gets nothing again', () => {
    const successorId = teleports(join(WORKER))
    send(join('rev-one'), WORKER, 'Status: DONE')
    const successor = join(WORKER, successorId)
    at(T0 + 5 * MINUTE)
    core.drop(successor.conn)

    expect(pushed(join(WORKER))).toEqual([])
  })

  it('takes no hold once the handoff is older than the teleport gap', () => {
    teleports(join(WORKER))
    at(T0 + TELEPORT_GAP_MS + MINUTE)

    const result = send(join('rev-one'), WORKER, 'Status: DONE')

    expect(result).toMatchObject({ ok: false, reason: `no active session named "${WORKER}"` })
  })

  it('still fails a send to a dark non-seat name that wrote no handoff', () => {
    const worker = join(WORKER)
    at(T0)
    core.drop(worker.conn)

    const result = send(join('rev-one'), WORKER, 'hello')

    expect(result).toMatchObject({ ok: false, reason: `no active session named "${WORKER}"` })
  })
})
