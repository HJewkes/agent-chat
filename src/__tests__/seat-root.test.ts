import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry, type IdentityBinding } from '../broker/registry.js'
import * as log from '../broker/log.js'
import { Supervisor, type SpawnOutcome, type SpawnRequest } from '../agents/supervisor.js'
import type { SeatTeleportDeps } from '../agents/seats/teleport-state.js'
import type { ClientMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1615: the launch-bound holder of a policy seat is a root coordinator under its ceiling, and
 * nothing short of that proof is. Every name, session id and path here is synthetic.
 */

const SEAT = 'seat-root'
const COUNTDOWN_MS = 1000
const POLICY = {
  version: 1,
  seats: {
    [SEAT]: {
      root: true,
      launchProfiles: ['opus-coordinator'],
      ceiling: ['bd-implementer', 'decider', 'opus-coordinator'],
    },
  },
}

const tmpDirs: string[] = []
let home: string
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

interface Requester {
  agentId: string
  name: string
  binding?: IdentityBinding
}

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function writeProfile(name: string, role: 'worker' | 'coordinator', model = 'sonnet'): void {
  fs.writeFileSync(
    path.join(home, 'profiles', `${name}.json`),
    JSON.stringify({ role, model, allowedTools: ['Read'], isolation: 'none', surface: 'headless' }),
  )
}

function writePolicy(policy: unknown): void {
  const file = path.join(home, 'seat-policy.json')
  fs.writeFileSync(file, JSON.stringify(policy))
  fs.chmodSync(file, 0o644)
}

const isolatedSeatTeleport = (): SeatTeleportDeps => ({
  autonomyRoot: tmp('seat-root-seats-'),
  now: () => new Date(),
  shepherd: async () => undefined,
})

function start(): void {
  sup = new Supervisor(core, {
    countdownMs: COUNTDOWN_MS,
    seatTeleport: isolatedSeatTeleport(),
    profileDriftMode: 'flag',
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    cwdLister: async () => [],
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid'),
    },
  })
}

const spawnRow = (agentId: string | undefined) =>
  core.events.agentEvents().find(row => row.kind === 'agent_spawned' && row.msgId === agentId)

const successorOf = (agentId: string) =>
  core.events.agentEvents().find(row => row.kind === 'agent_spawned' && row.meta.teleport_from === agentId)

function spawn(
  name: string,
  profile: string,
  by?: Requester,
  over: Partial<SpawnRequest> = {},
): Promise<SpawnOutcome> {
  return sup.spawn({
    name,
    profile,
    brief: 'do the task',
    requestedBy: by?.name ?? 'human',
    ...(by === undefined ? {} : { parentAgentId: by.agentId }),
    ...(by?.binding === undefined ? {} : { requesterBinding: by.binding }),
    cwd: tmp('seat-root-cwd-'),
    surface: 'headless',
    spawnerConfigDir: tmp('seat-root-account-'),
    ...over,
  })
}

/** Spawns `name`, expecting it to launch, and returns it as a launch-bound requester. */
async function launched(name: string, profile: string, by?: Requester): Promise<Requester> {
  const outcome = await spawn(name, profile, by)
  expect(outcome.ok, outcome.reason).toBe(true)
  return { agentId: outcome.agentId as string, name, binding: 'launch' }
}

/** A coordinator chain from the human down to `depth`, ending in a coordinator that launches the seat. */
async function coordinatorAt(depth: number): Promise<Requester> {
  let by: Requester | undefined
  for (let level = 1; level <= depth; level++) by = await launched(`coord-${level}`, 'opus-coordinator', by)
  return by as Requester
}

/** The seat as a depth-3 coordinator started it, as `launched` gives it back. */
const seatAtDepth3 = async (): Promise<Requester> =>
  launched(SEAT, 'opus-coordinator', await coordinatorAt(2))

function registerAs(
  name: string,
  sessionId: string,
): { conn: Conn; agentId: string; binding: IdentityBinding } {
  const conn = { write: () => true } as unknown as Conn
  const frame: Extract<ClientMessage, { t: 'register' }> = {
    t: 'register',
    name,
    workingOn: 'testing',
    cwd: '/tmp',
    pid: 1,
    sessionId,
  }
  expect(core.register(conn, frame).ok).toBe(true)
  const entry = core.registry.entryFor(conn)
  return { conn, agentId: entry?.agentId as string, binding: entry?.binding as IdentityBinding }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: unknown) => {
    if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    return true
  })
  home = tmp('seat-root-home-')
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('opus-coordinator', 'coordinator', 'opus')
  writeProfile('peer', 'coordinator')
  for (const name of ['bd-implementer', 'decider', 'researcher']) writeProfile(name, 'worker')
  writePolicy(POLICY)
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  start()
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

describe('a seat started by another coordinator', () => {
  // Catches: dropping the seat-launch exception in checkRole ("depth 4 exceeds").
  it('launches past the depth cap and puts its coordinator children at depth 1', async () => {
    const seat = await launched(SEAT, 'opus-coordinator', await coordinatorAt(3))

    const child = await launched('seat-child', 'opus-coordinator', seat)

    expect(spawnRow(child.agentId)?.meta).toMatchObject({ coordinator_depth: '1', seat_ceiling: SEAT })
  })

  it('still holds the launcher to CC-39 when the seat profile grants more than it has', async () => {
    fs.writeFileSync(
      path.join(home, 'profiles', 'opus-coordinator.json'),
      JSON.stringify({
        role: 'coordinator',
        model: 'opus',
        allowedTools: ['Read', 'Bash'],
        isolation: 'none',
        surface: 'headless',
      }),
    )
    sup.close()
    start()
    const launcher = await launched('launcher-a', 'peer')

    const outcome = await spawn(SEAT, 'opus-coordinator', launcher)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/grants tools you were not granted \(Bash\)/)
  })
})

describe('a teleported seat', () => {
  async function teleported(): Promise<Requester> {
    const seat = await seatAtDepth3()
    const result = await sup.teleport({
      subject: {
        agentId: seat.agentId,
        name: SEAT,
        cwd: tmp('seat-root-cwd-'),
        hostPid: 9999,
        host: os.hostname(),
        tags: [],
        subscriptions: [],
      },
      handoff: 'h',
    })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    expect(result.ok).toBe(true)
    const successor = successorOf(seat.agentId)
    expect(successor?.meta.coordinator_depth).toBe('3')
    return { agentId: successor?.msgId as string, name: SEAT, binding: 'launch' }
  }

  it('spawns a ceiling worker', async () => {
    const seat = await teleported()

    const outcome = await spawn('seat-decider', 'decider', seat)

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(spawnRow(outcome.agentId)?.meta.seat_ceiling).toBe(SEAT)
  })

  // Catches: reading the carried coordinator depth (3) for the successor, which refuses at depth 4.
  it('puts its coordinator children at depth 1 under the seat ceiling', async () => {
    const seat = await teleported()

    const child = await launched('seat-child', 'opus-coordinator', seat)

    expect(spawnRow(child.agentId)?.meta).toMatchObject({ coordinator_depth: '1', seat_ceiling: SEAT })
  })
})

describe('a seat several teleport generations on (CC-1675)', () => {
  async function teleportOnce(holder: Requester): Promise<Requester> {
    const result = await sup.teleport({
      subject: {
        agentId: holder.agentId,
        name: SEAT,
        cwd: tmp('seat-root-cwd-'),
        hostPid: 9999,
        host: os.hostname(),
        tags: [],
        subscriptions: [],
      },
      handoff: 'h',
    })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    expect(result.ok, result.reason).toBe(true)
    return { agentId: successorOf(holder.agentId)?.msgId as string, name: SEAT, binding: 'launch' }
  }

  async function generation(count: number): Promise<Requester> {
    let holder = await seatAtDepth3()
    for (let step = 1; step < count; step++) holder = await teleportOnce(holder)
    return holder
  }

  // Catches: reading the depth every generation carries (3) instead of the seat root's 0.
  it('spawns an opus-coordinator at depth 1', async () => {
    const seat = await generation(4)
    expect(spawnRow(seat.agentId)?.meta).toMatchObject({ generation: '4', coordinator_depth: '3' })

    const child = await launched('seat-coord', 'opus-coordinator', seat)

    expect(spawnRow(child.agentId)?.meta).toMatchObject({ coordinator_depth: '1', seat_ceiling: SEAT })
  })

  // Catches: a policy cache, or a root depth written onto the row, outliving a revoke.
  it('is refused on the next request once the seat is revoked', async () => {
    const seat = await generation(3)
    expect((await spawn('seat-coord', 'opus-coordinator', seat)).ok).toBe(true)
    writePolicy({ version: 1, seats: {} })

    const outcome = await spawn('seat-coord-2', 'opus-coordinator', seat)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/coordinator depth 4 exceeds the cap of 3/)
    expect(outcome.reason).toContain(`"${SEAT}" is not a seat in`)
  })
})

describe('the depth refusal (CC-1675)', () => {
  // Catches: a refusal that does not say which seat-policy entry would have made the requester root.
  it('refuses a non-seat coordinator at depth 3, naming the seat policy', async () => {
    const coordinator = await coordinatorAt(3)

    const outcome = await spawn('coord-d', 'opus-coordinator', coordinator)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/coordinator depth 4 exceeds the cap of 3/)
    expect(outcome.reason).toMatch(/"coord-3" is not a seat in \S*seat-policy\.json/)
  })

  it('names the launch profile the seat entry is missing', async () => {
    const seat = await launched(SEAT, 'peer', await coordinatorAt(2))

    const outcome = await spawn('seat-coord', 'opus-coordinator', seat)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/seat "seat-root" in \S*seat-policy\.json does not list profile "peer"/)
  })

  // Catches: a lineage carry that lowers a relaunched coordinator's depth below its earlier identity's.
  it('keeps a relaunched non-seat coordinator at its earlier depth', async () => {
    const earlier = await coordinatorAt(3)
    core.append({ kind: 'agent_retired', actor: 'human', target: 'coord-3', ref: earlier.agentId })
    const relaunch = await spawn('coord-3', 'opus-coordinator', undefined, { lineageFrom: earlier.agentId })
    expect(relaunch.ok, relaunch.reason).toBe(true)
    const coordinator: Requester = { agentId: relaunch.agentId as string, name: 'coord-3', binding: 'launch' }

    const outcome = await spawn('coord-d', 'opus-coordinator', coordinator)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/coordinator depth 4 exceeds the cap of 3/)
  })
})

describe('a seat on a different account', () => {
  // Catches: requiring the seat row's config dir to match its launcher's.
  it('is root whatever account it was launched on', async () => {
    const launcher = await coordinatorAt(2)
    const seatOutcome = await spawn(SEAT, 'opus-coordinator', launcher, {
      spawnerConfigDir: tmp('seat-root-other-'),
    })
    expect(spawnRow(seatOutcome.agentId)?.meta.config_dir).not.toBe(
      spawnRow(launcher.agentId)?.meta.config_dir,
    )
    const seat: Requester = { agentId: seatOutcome.agentId as string, name: SEAT, binding: 'launch' }

    const child = await launched('seat-child', 'opus-coordinator', seat)

    expect(spawnRow(child.agentId)?.meta).toMatchObject({ coordinator_depth: '1', seat_ceiling: SEAT })
  })
})

describe('the ceiling', () => {
  // Catches: falling through to CC-39/40, which the Read-only researcher would pass.
  it('refuses a profile it does not list, naming the policy file', async () => {
    const seat = await seatAtDepth3()

    const outcome = await spawn('seat-researcher', 'researcher', seat)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/"researcher" is not in the spawn ceiling/)
    expect(outcome.reason).toContain('seat-policy.json')
  })

  it('refuses an unlisted profile on a spawn launched on the caller host', async () => {
    const seat = await seatAtDepth3()

    const outcome = await spawn('seat-researcher', 'researcher', seat, {
      cwd: `/Users/${os.userInfo().username}/projects/proj-a`,
      surface: 'iterm-tab',
      callerHost: 'caller-test-host',
      hostPlatform: 'darwin',
      launchesHere: true,
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/not in the spawn ceiling/)
  })

  // Catches: dropping the drift check, which profileDrift=flag alone lets through with a warning.
  it('refuses a ceiling profile whose file changed since broker start', async () => {
    const seat = await seatAtDepth3()
    writeProfile('decider', 'worker', 'haiku')

    const outcome = await spawn('seat-decider', 'decider', seat)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/changed after the broker started/)
  })
})

describe('an impostor seat name', () => {
  // Catches: keying root on the requester's name alone.
  it('gets nothing from chat_register under the seat name while the seat is dark', async () => {
    const impostor = registerAs(SEAT, 'session-impostor')
    expect(impostor.binding).toBe('adopted')

    const outcome = await spawn('impostor-child', 'peer', {
      agentId: impostor.agentId,
      name: SEAT,
      binding: impostor.binding,
    })

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(spawnRow(outcome.agentId)?.meta).not.toHaveProperty('seat_ceiling')
  })

  it('gets nothing from presenting an adopted seat holder’s session id under another name', async () => {
    const first = registerAs(SEAT, 'session-held')
    core.drop(first.conn)
    const impostor = registerAs('evil', 'session-held')
    expect(impostor).toMatchObject({ agentId: first.agentId, binding: 'session' })

    const outcome = await spawn('impostor-child', 'peer', {
      agentId: impostor.agentId,
      name: 'evil',
      binding: impostor.binding,
    })

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(spawnRow(outcome.agentId)?.meta).not.toHaveProperty('seat_ceiling')
  })

  // Catches: dropping the binding === 'launch' check.
  it('gets nothing from the real seat id bound any way but launch', async () => {
    const seat = await launched(SEAT, 'opus-coordinator')

    const outcome = await spawn('impostor-child', 'peer', { ...seat, binding: 'session' })

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(spawnRow(outcome.agentId)?.meta).toMatchObject({ coordinator_depth: '2' })
    expect(spawnRow(outcome.agentId)?.meta).not.toHaveProperty('seat_ceiling')
  })

  // Catches: dropping the check that the requester's name equals the seat row's target.
  it('gets nothing from the real seat id presented under another name', async () => {
    const seat = await launched(SEAT, 'opus-coordinator')

    const outcome = await spawn('impostor-child', 'peer', { ...seat, name: 'evil' })

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(spawnRow(outcome.agentId)?.meta).not.toHaveProperty('seat_ceiling')
  })

  // Catches: dropping the launchProfiles check.
  it('gets nothing from a seat-named launch with a profile the policy does not list', async () => {
    const logged = vi.spyOn(log, 'logEvent')
    const outcome = await spawn(SEAT, 'peer', await coordinatorAt(1))
    expect(outcome.ok, outcome.reason).toBe(true)
    expect(outcome.warnings?.join('\n')).toMatch(/not one of its launch profiles/)
    expect(logged).toHaveBeenCalledWith(
      'seat_root_denied',
      expect.objectContaining({ name: SEAT, profile: 'peer' }),
    )
    const seat: Requester = { agentId: outcome.agentId as string, name: SEAT, binding: 'launch' }

    const child = await spawn('seat-researcher', 'researcher', seat)

    expect(child.ok, child.reason).toBe(true)
    expect(spawnRow(child.agentId)?.meta).not.toHaveProperty('seat_ceiling')
  })
})

describe('without the policy', () => {
  it('refuses the seat launch at depth 4 when the file is absent', async () => {
    fs.rmSync(path.join(home, 'seat-policy.json'))

    const outcome = await spawn(SEAT, 'opus-coordinator', await coordinatorAt(3))

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/coordinator depth 4 exceeds the cap of 3/)
  })

  it('refuses a seat coordinator child at depth 4 when the file is absent', async () => {
    const seat = await seatAtDepth3()
    fs.rmSync(path.join(home, 'seat-policy.json'))

    const outcome = await spawn('seat-child', 'opus-coordinator', seat)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/coordinator depth 4 exceeds/)
  })

  // Catches: a policy cache that ignores the file changing.
  it('applies a revoke to the next spawn, with no relaunch', async () => {
    const seat = await seatAtDepth3()
    expect((await spawn('seat-researcher', 'researcher', seat)).ok).toBe(false)
    writePolicy({ version: 1, seats: {} })

    const outcome = await spawn('seat-researcher', 'researcher', seat)

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(spawnRow(outcome.agentId)?.meta).not.toHaveProperty('seat_ceiling')
  })
})
