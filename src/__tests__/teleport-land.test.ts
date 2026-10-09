import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { LAND_WINDOW_MS } from '../agents/teleport.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-913, over the socket: a teleport from another host arms its successor, and only the caller
 * that armed it, holding the landing token from the plan, may later report it unplaced. The
 * report is refused once the successor has registered, even after it disconnects again.
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-land-'))
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
    surface: { platform: 'linux', runAppleScript: () => Promise.resolve('') },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  fs.rmSync(home, { recursive: true, force: true })
})

function wire(): Wire {
  const frames: ServerMessage[] = []
  const conn = Object.assign(new EventEmitter(), {
    write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
  })
  server.onConnection(conn as unknown as Conn)
  return { conn, frames, send: msg => conn.emit('data', JSON.stringify(msg) + '\n') }
}

function lastOf<T extends ServerMessage['t']>(
  caller: Wire,
  t: T,
): Extract<ServerMessage, { t: T }> | undefined {
  return caller.frames.filter((f): f is Extract<ServerMessage, { t: T }> => f.t === t).at(-1)
}

const register = (caller: Wire, extra: Partial<Extract<ClientMessage, { t: 'register' }>>) =>
  caller.send({ t: 'register', name: 'cc27', workingOn: 'work', cwd: home, pid: 111, host: REMOTE, ...extra })

/** Runs a remote teleport to an accepted report; returns the successor id and its landing token. */
async function armedLanding(): Promise<{ successor: string; token: string; predecessor: Wire }> {
  const predecessor = wire()
  register(predecessor, { sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', hostPid: 83212 })
  predecessor.send({ t: 'teleport', handoff: 'carry on' })
  await vi.advanceTimersByTimeAsync(0)
  predecessor.send({ t: 'teleport_plan_wait' })
  await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
  const launch = lastOf(predecessor, 'teleport_plan')?.launch
  if (launch?.landToken === undefined) throw new Error('no landing token in the plan')
  predecessor.send({ t: 'teleport_launched', agentId: launch.agentId, ok: true })
  expect(lastOf(predecessor, 'teleport_launched_result')).toMatchObject({ ok: true })
  return { successor: launch.agentId, token: launch.landToken, predecessor }
}

const landFailed = (agentId: string, token: string) => {
  const anyone = wire()
  anyone.send({ t: 'teleport_land_failed', agentId, token, reason: 'iTerm is not running' })
  return lastOf(anyone, 'teleport_land_failed_result')
}

const stateOf = (agentId: string) => core.agents.get(agentId)?.state
const failedNotices = () => core.events.humanQueue().filter(item => item.text.includes('failed to start'))

describe('reporting an armed teleport successor unplaced', () => {
  it('accepts the landing token while the successor has never registered, and keeps a live predecessor', async () => {
    const { successor, token } = await armedLanding()

    expect(landFailed(successor, token)).toEqual({
      t: 'teleport_land_failed_result',
      ok: true,
      predecessorLive: true,
    })
    expect(stateOf(successor)).toBe('retired')
  })

  it('tells the human once the predecessor was already retired', async () => {
    const { successor, token, predecessor } = await armedLanding()
    predecessor.conn.emit('close')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(landFailed(successor, token)).toMatchObject({ ok: true, predecessorLive: false })
    expect(failedNotices()).toHaveLength(1)
  })

  // The reviewer's probe: before the fix this retired a live successor and told the human it never started.
  it('refuses even the right token once the successor registered and disconnected', async () => {
    const { successor, token, predecessor } = await armedLanding()
    predecessor.conn.emit('close')
    const started = wire()
    register(started, { agentId: successor })
    expect(lastOf(started, 'register_result')).toMatchObject({ ok: true })
    started.conn.emit('close')

    expect(landFailed(successor, token)).toMatchObject({ ok: false })
    expect(stateOf(successor)).not.toBe('retired')
    expect(failedNotices()).toEqual([])
  })

  it('refuses a wrong token and leaves the successor alone', async () => {
    const { successor, token } = await armedLanding()

    expect(
      landFailed(
        successor,
        token.replace(/.$/, c => (c === '0' ? '1' : '0')),
      ),
    ).toMatchObject({ ok: false })
    expect(landFailed(successor, '')).toMatchObject({ ok: false })
    expect(stateOf(successor)).not.toBe('retired')
  })

  it('refuses a stale token once the landing window has passed', async () => {
    const { successor, token } = await armedLanding()

    await vi.advanceTimersByTimeAsync(LAND_WINDOW_MS)

    expect(landFailed(successor, token)).toMatchObject({ ok: false })
    expect(stateOf(successor)).not.toBe('retired')
  })

  it('refuses an agent that has no armed landing', async () => {
    const { token, predecessor } = await armedLanding()
    const predecessorId = core.registry.entryFor(predecessor.conn as unknown as Conn)?.agentId as string

    expect(landFailed(predecessorId, token)).toMatchObject({ ok: false })
  })
})
