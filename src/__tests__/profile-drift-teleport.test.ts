import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SpawnOutcome } from '../agents/supervisor.js'
import { ProfileBaseline, type ProfileDriftMode } from '../agents/profile-baseline.js'
import type { SeatTeleportDeps } from '../agents/seats/teleport-state.js'
import { autoAttach } from './broker-harness.js'

/** CC-1203: a teleport loads its successor's profile through the drift check, and never re-baselines it. */

const COUNTDOWN_MS = 1000
const tmpDirs: string[] = []
let home: string
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const profileFile = (name: string): string => path.join(home, 'profiles', `${name}.json`)

function writeProfile(name: string, description = name): void {
  fs.writeFileSync(
    profileFile(name),
    JSON.stringify({
      description,
      model: 'sonnet',
      allowedTools: ['Read'],
      isolation: 'none',
      surface: 'headless',
    }),
  )
}

const isolatedSeatTeleport = (): SeatTeleportDeps => ({
  autonomyRoot: tmp('drift-seats-'),
  now: () => new Date(),
  shepherd: async () => undefined,
})

function start(mode: ProfileDriftMode): void {
  sup?.close()
  sup = new Supervisor(core, {
    countdownMs: COUNTDOWN_MS,
    seatTeleport: isolatedSeatTeleport(),
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    cwdLister: async () => [],
    profileBaseline: new ProfileBaseline(path.join(home, 'profiles')),
    profileDriftMode: mode,
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid'),
    },
  })
}

const spawn = (name: string, requestedBy: string): Promise<SpawnOutcome> =>
  sup.spawn({
    name,
    profile: 'bd-implementer',
    brief: 'do the task',
    requestedBy,
    cwd: tmp('drift-cwd-'),
    surface: 'headless',
    spawnerConfigDir: tmp('drift-account-'),
  })

const subject = (agentId: string, name: string, cwd = tmp('drift-cwd-')) => ({
  agentId,
  name,
  cwd,
  hostPid: 9999,
  host: os.hostname(),
  tags: [] as string[],
  subscriptions: [],
})

/** A hand-started session, adopted the way `chat_register` adopts one. */
function adoptSession(name: string, cwd: string): string {
  const conn = {} as unknown as net.Socket
  core.register(conn, {
    t: 'register',
    name,
    workingOn: 'its own work',
    cwd,
    pid: 111,
    sessionId: 'session-uuid-1',
    hostPid: 222,
    host: os.hostname(),
  })
  const agentId = core.registry.entryFor(conn)?.agentId as string
  core.drop(conn)
  return agentId
}

const handoffs = () => core.events.agentEvents().filter(row => row.kind === 'agent_handoff')

const driftWarnings = (outcome: SpawnOutcome): string[] =>
  (outcome.warnings ?? []).filter(warning => warning.includes('after the broker started'))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: unknown) => {
    if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    return true
  })
  home = tmp('drift-home-')
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('bd-implementer')
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('profile drift at teleport (CC-1203)', () => {
  it('refuses a teleport into a rewritten profile under refuse, recording no handoff', async () => {
    start('refuse')
    const worker = await spawn('worker-t', 'seat-a')
    writeProfile('bd-implementer', 'rewritten')

    const result = await sup.teleport({ subject: subject(worker.agentId as string, 'worker-t'), handoff: 'h' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(profileFile('bd-implementer'))
    expect(handoffs()).toEqual([])
  })

  it('lets a teleport into a rewritten profile through under flag without taking it as the baseline', async () => {
    start('flag')
    const worker = await spawn('worker-t', 'seat-a')
    writeProfile('bd-implementer', 'rewritten')

    const result = await sup.teleport({ subject: subject(worker.agentId as string, 'worker-t'), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    const after = await spawn('worker-u', 'seat-a')

    expect(result.ok).toBe(true)
    expect(driftWarnings(after)).toEqual([expect.stringContaining(profileFile('bd-implementer'))])
  })

  it('still teleports an adopted session after the profile directory is rewritten', async () => {
    start('refuse')
    const cwd = tmp('drift-cwd-')
    const agentId = adoptSession('agent-x', cwd)
    writeProfile('bd-implementer', 'rewritten')
    writeProfile('newcomer')

    const result = await sup.teleport({ subject: subject(agentId, 'agent-x', cwd), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)

    expect(result.ok).toBe(true)
    expect(handoffs()).toHaveLength(1)
  })
})
