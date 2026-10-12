import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import {
  brokerJobKick,
  jobKicker,
  jobKickCommand,
  type JobKickPorts,
  type JobKickRequest,
} from '../broker/job-kick.js'
import { kickEnv } from '../broker/burndown-kick.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { cliEntry } from '../paths.js'
import { jobEnv } from '../mirror/plist.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/** CC-1151 slice a: the broker runs a kicked tick, watchdog or heartbeat check in its own env. */

const PLANTED = {
  env: { PATH: '/tmp/fake', GH_TOKEN: 'planted', HOME: '/tmp/planted' },
  root: '/tmp/planted',
  args: ['--root', '/tmp/x'],
}

let home: string
let server: SocketServer
let kicked: JobKickRequest[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-job-kick-'))
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core)
  kicked = []
  server.attachJobKick(request => {
    kicked.push(request)
    return { ok: true, detail: 'recorded' }
  })
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function kick(frame: Record<string, unknown>): Extract<ServerMessage, { t: 'job_kick_result' }> | undefined {
  const frames: ServerMessage[] = []
  const record = (line: string) => frames.push(JSON.parse(line) as ServerMessage)
  const conn = Object.assign(new EventEmitter(), { write: record, end: record })
  server.onConnection(conn as unknown as Conn)
  conn.emit('data', JSON.stringify({ t: 'job_kick', ...frame } as ClientMessage) + '\n')
  return frames.find(f => f.t === 'job_kick_result') as
    Extract<ServerMessage, { t: 'job_kick_result' }> | undefined
}

describe('job_kick frame', () => {
  it('reaches the port as exactly the job, whatever else the caller planted on the frame', () => {
    const result = kick({ job: 'burndown_tick', ...PLANTED })

    expect(result).toEqual({ t: 'job_kick_result', ok: true, detail: 'recorded' })
    expect(kicked).toEqual([{ job: 'burndown_tick' }])
  })

  it('passes a heartbeat check its seat and nothing else', () => {
    kick({ job: 'seats_heartbeat_check', seat: 'review', ...PLANTED })

    expect(kicked).toEqual([{ job: 'seats_heartbeat_check', seat: 'review' }])
  })

  it.each([
    ['an unknown job', { job: 'rm_rf' }],
    ['a heartbeat check with no seat', { job: 'seats_heartbeat_check' }],
    ['a heartbeat check on a path', { job: 'seats_heartbeat_check', seat: '../x' }],
    ['a seat on a tick', { job: 'burndown_tick', seat: 'review' }],
    ['a seat on a watchdog', { job: 'seats_watchdog', seat: 'review' }],
  ])('refuses %s', (_label, frame) => {
    const result = kick(frame)

    expect(result?.ok).toBe(false)
    expect(kicked).toEqual([])
  })

  it('refuses when no port is attached', () => {
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(home, 'bare.db')),
      registry: new Registry<Conn>(),
    })
    server = new SocketServer(core)

    expect(kick({ job: 'seats_watchdog' })?.ok).toBe(false)
  })
})

describe('kicked job command', () => {
  const BROKER_ENV = {
    HOME: 'broker-home',
    PATH: '/usr/bin',
    XDG_RUNTIME_DIR: 'broker-runtime',
    GH_TOKEN: 'broker-token',
    GH_CONFIG_DIR: 'broker-gh',
    GIT_DIR: 'broker-git',
    AGENT_CHAT_AGENT_ID: 'an-id',
    NODE_OPTIONS: '--require x',
  }

  it.each<[JobKickRequest, string[]]>([
    [{ job: 'burndown_tick' }, ['burndown', 'tick', '--once']],
    [{ job: 'seats_watchdog' }, ['seats', 'watchdog']],
    [{ job: 'seats_heartbeat_check', seat: 'review' }, ['seats', 'heartbeat-check', '--seat', 'review']],
  ])('runs the fixed command for %j', (request, verb) => {
    const { command, args } = jobKickCommand(request, BROKER_ENV)

    expect(command).toBe(process.execPath)
    expect(args).toEqual([cliEntry(), ...verb])
  })

  it.each<JobKickRequest>([
    { job: 'burndown_tick' },
    { job: 'seats_watchdog' },
    { job: 'seats_heartbeat_check', seat: 'review' },
  ])("passes %j only the job env and the broker's user bus", request => {
    const { env } = jobKickCommand(request, BROKER_ENV)

    expect(env).toEqual({ ...jobEnv(BROKER_ENV), XDG_RUNTIME_DIR: 'broker-runtime' })
    expect(env).toEqual(kickEnv(BROKER_ENV))
    expect(Object.keys(env).filter(k => /^(GH_|GIT_|NODE_OPTIONS|AGENT_CHAT_AGENT_ID)/.test(k))).toEqual([])
  })
})

describe('job kicker', () => {
  function harness(): {
    ports: JobKickPorts
    launches: Array<() => void>
    ticks: number[]
    logged: unknown[]
  } {
    const launches: Array<() => void> = []
    const ticks: number[] = []
    const logged: unknown[] = []
    const ports: JobKickPorts = {
      requestTick: () => {
        ticks.push(1)
        return 'launched'
      },
      launch: (_request, done) => launches.push(done),
      log: (event, detail) => logged.push({ event, ...detail }),
    }
    return { ports, launches, ticks, logged }
  }

  it('coalesces a second watchdog kick while one runs, and launches again after it ends', () => {
    const h = harness()
    const kick = jobKicker(h.ports)

    const first = kick({ job: 'seats_watchdog' })
    const second = kick({ job: 'seats_watchdog' })
    h.launches[0]?.()
    const third = kick({ job: 'seats_watchdog' })

    expect([first.detail, second.detail, third.detail]).toEqual([
      'launched',
      'coalesced: already running',
      'launched',
    ])
    expect(h.launches).toHaveLength(2)
  })

  it('runs heartbeat checks for different seats side by side', () => {
    const h = harness()
    const kick = jobKicker(h.ports)

    kick({ job: 'seats_heartbeat_check', seat: 'a' })
    kick({ job: 'seats_heartbeat_check', seat: 'b' })

    expect(h.launches).toHaveLength(2)
  })

  it('sends a tick kick through the burndown kicker and logs a job_kick row naming the job', () => {
    const h = harness()
    const kick = jobKicker(h.ports)

    kick({ job: 'burndown_tick' })

    expect(h.ticks).toHaveLength(1)
    expect(h.launches).toHaveLength(0)
    expect(h.logged).toEqual([{ event: 'job_kick', job: 'burndown_tick', detail: 'launched' }])
  })

  it('in an ephemeral home records the kick and launches nothing', () => {
    const kick = brokerJobKick(undefined)

    expect(kick({ job: 'seats_watchdog' })).toEqual({
      ok: true,
      detail: 'accepted (ephemeral home: not launched)',
    })
  })
})
