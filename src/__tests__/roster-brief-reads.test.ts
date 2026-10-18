import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1484: a spawn's brief over 512 bytes stays in the db and is read back by id.
 * Every `agents` reply is stringified, so a brief on the wire cost one read per
 * agent on every full-roster poll. The broker's own readers still get it.
 */

let dir: string
let events: EventLog
let core: BrokerCore
let server: net.Server | undefined
let client: BrokerClient | undefined
let bodyReads = 0
const previousHome = process.env['AGENT_CHAT_HOME']

const BRIEF = `do the task\n${'x'.repeat(2048)}`

/** Counts each run of the deferred-body statement, which is prepared on first use. */
function countBodyReads(log: EventLog): void {
  const db = log.ledgerHandle()
  const prepare = db.prepare.bind(db)
  db.prepare = (sql: string) => {
    const stmt = prepare(sql)
    if (sql !== 'SELECT body FROM events WHERE id = ?') return stmt
    const get = stmt.get.bind(stmt)
    stmt.get = (...params: never[]) => {
      bodyReads += 1
      return get(...params)
    }
    return stmt
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1484-'))
  process.env['AGENT_CHAT_HOME'] = dir
  events = new EventLog(path.join(dir, 'events.db'))
  countBodyReads(events)
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  const socketServer = new SocketServer(core)
  const listener = net.createServer(conn => socketServer.onConnection(conn))
  server = listener
  await new Promise<void>(resolve => listener.listen(path.join(dir, 'chat.sock'), resolve))
  client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, { autoStart: false })
  await client.connect()
})

afterEach(async () => {
  client?.close()
  client = undefined
  const listener = server
  server = undefined
  if (listener) await new Promise<void>(resolve => listener.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

/** `adopted` as the broker writes it today: `provisional` stated, so the fold never reads the body. */
function spawnWithBrief(name: string, origin: Record<string, string> = {}): void {
  core.append({
    kind: 'agent_spawned',
    actor: 'seat-a',
    target: name,
    body: BRIEF,
    meta: { name, profile: 'impl', cwd: dir, session_id: `session-${name}`, depth: '0', ...origin },
  })
}

const request = (frame: ClientMessage, reply: ServerMessage['t']) => client!.request(frame, reply as never)

describe('a full-roster agents reply over spawns with long briefs', () => {
  it.each([{ t: 'agents' as const }, { t: 'agents' as const, includeRetired: true }])(
    'reads no brief back from the db for %o',
    async frame => {
      for (let i = 0; i < 20; i += 1) spawnWithBrief(`agent-x-${i}`)
      bodyReads = 0

      const res = (await request(frame, 'agents_result')) as Extract<ServerMessage, { t: 'agents_result' }>

      expect(res.agents).toHaveLength(20)
      expect(bodyReads).toBe(0)
      expect(res.agents.some(a => 'brief' in a)).toBe(false)
    },
  )

  it('still hands a readopted session its brief as what it is working on', async () => {
    spawnWithBrief('impl', { origin: 'adopted', provisional: 'false' })

    await request({ t: 'readopt', sessionId: 'session-impl', cwd: dir, pid: 4243 }, 'register_result')
    const list = (await request({ t: 'list' }, 'list_result')) as Extract<ServerMessage, { t: 'list_result' }>

    expect(list.sessions.find(s => s.name === 'impl')?.workingOn).toBe(BRIEF)
  })
})
