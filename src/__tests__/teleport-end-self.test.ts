import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-951 slice f, over the socket: a predecessor on another host moves to the broker's host. Its
 * successor's registration evicts it, and its `endSelf` must reach it before the fatal close,
 * since after that close its MCP process exits and nothing on its host can end its Claude Code.
 */

const REMOTE = 'someone-elses-laptop.invalid'
const COUNTDOWN_MS = 1000

interface Wire {
  conn: EventEmitter
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
}

let home: string
let core: BrokerCore
let server: SocketServer

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-endself-'))
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core, {
    countdownMs: COUNTDOWN_MS,
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: () => Promise.resolve(''),
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  fs.rmSync(home, { recursive: true, force: true })
})

/** `end` is how the broker closes an evicted connection, with its last frame. */
function wire(): Wire {
  const frames: ServerMessage[] = []
  const record = (line: string) => frames.push(JSON.parse(line) as ServerMessage)
  const conn = Object.assign(new EventEmitter(), { write: record, end: record })
  server.onConnection(conn as unknown as Conn)
  return { conn, frames, send: msg => conn.emit('data', JSON.stringify(msg) + '\n') }
}

const successorOf = (): string =>
  core.events.agentEvents().find(row => row.kind === 'agent_handoff')?.meta?.successor as string

describe('a remote predecessor ending itself on its successor’s attach', () => {
  it('reads endSelf before the fatal frame that closes its evicted connection', async () => {
    const predecessor = wire()
    predecessor.send({
      t: 'register',
      name: 'cc27',
      workingOn: 'work',
      cwd: home,
      pid: 111,
      host: REMOTE,
      hostPid: 83212,
      sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    })
    predecessor.send({ t: 'teleport', handoff: 'carry on', to: os.hostname(), surface: 'headless' })
    await vi.advanceTimersByTimeAsync(0)
    predecessor.send({ t: 'teleport_plan_wait' })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    expect(predecessor.frames.map(f => f.t)).not.toContain('teleport_plan')

    wire().send({ t: 'register', name: 'cc27', workingOn: 'w', cwd: home, pid: 2, agentId: successorOf() })
    await vi.advanceTimersByTimeAsync(1)

    const tail = predecessor.frames.filter(f => f.t === 'teleport_plan' || f.t === 'error')
    expect(tail).toEqual([
      { t: 'teleport_plan', ok: true, endSelf: true },
      { t: 'error', reason: 'superseded by a resume of "cc27"', fatal: true },
    ])
  })
})
