import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import * as log from '../broker/log.js'
import { Supervisor, type SpawnOutcome } from '../agents/supervisor.js'
import { singleInstanceVerdict } from '../agents/seats/single-instance.js'
import type { ClientMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/** TP-5768: one holder per policy seat. Every seat name, session id and path here is synthetic. */

const SEAT = 'lantern-steward'
const POLICY = {
  version: 1,
  seats: { [SEAT]: { root: true, launchProfiles: ['seat-coordinator'], ceiling: ['seat-worker'] } },
}

const tmpDirs: string[] = []
let home: string
let events: EventLog
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function writeProfile(name: string, role: 'worker' | 'coordinator'): void {
  fs.writeFileSync(
    path.join(home, 'profiles', `${name}.json`),
    JSON.stringify({ role, model: 'sonnet', allowedTools: ['Read'], isolation: 'none', surface: 'headless' }),
  )
}

function writePolicy(): void {
  const file = path.join(home, 'seat-policy.json')
  fs.writeFileSync(file, JSON.stringify(POLICY))
  fs.chmodSync(file, 0o644)
}

function start(): void {
  sup = new Supervisor(core, {
    countdownMs: 1000,
    seatTeleport: { autonomyRoot: tmp('ssi-seats-'), now: () => new Date(), shepherd: async () => undefined },
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

const spawnSeat = (name = SEAT): Promise<SpawnOutcome> =>
  sup.spawn({
    name,
    profile: 'seat-coordinator',
    brief: 'keep the seat',
    requestedBy: 'human',
    cwd: tmp('ssi-cwd-'),
    surface: 'headless',
    spawnerConfigDir: tmp('ssi-account-'),
  })

const frame = (
  name: string,
  sessionId: string,
  agentId?: string,
): Extract<ClientMessage, { t: 'register' }> => ({
  t: 'register',
  name,
  workingOn: 'holding the seat',
  cwd: '/tmp',
  pid: 1,
  sessionId,
  ...(agentId === undefined ? {} : { agentId }),
})

const newConn = (): Conn => ({ write: () => true }) as unknown as Conn

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: unknown) => {
    if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    return true
  })
  home = tmp('ssi-home-')
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('seat-coordinator', 'coordinator')
  writeProfile('seat-worker', 'worker')
  writePolicy()
  events = new EventLog(path.join(home, 'events.db'))
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

function setMode(mode: string): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ seatSingleInstance: { mode } }))
}

/** A hand-started session holding `name`, still `live` in the log after a broker restart it has not reconnected to. */
function adoptedAcrossRestart(name: string): string {
  const conn = newConn()
  expect(core.register(conn, frame(name, 'session-hand-1')).ok).toBe(true)
  const agentId = core.registry.entryFor(conn)?.agentId as string
  stopAutoAttach()
  sup.close()
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  start()
  return agentId
}

/** The seat as the broker launched it, then detached. */
async function detachedLaunch(): Promise<string> {
  const launched = await spawnSeat()
  expect(launched.ok, launched.reason).toBe(true)
  const agentId = launched.agentId as string
  await Promise.resolve()
  core.append({ kind: 'agent_detached', actor: SEAT, ref: agentId, body: 'connection closed' })
  expect(core.agents.get(agentId)?.state).toBe('detached')
  return agentId
}

/** A broker-written identity under the seat's name, optionally a teleport successor of `from`. */
function mintUnderSeat(agentId: string, from?: string): void {
  core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: SEAT,
    msgId: agentId,
    body: 'keep the seat',
    meta: from === undefined ? {} : { teleport_from: from },
  })
}

const wouldRefuseRows = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
  spy.mock.calls.filter(([kind]) => kind === 'seat_single_instance_would_refuse').map(([, detail]) => detail)

describe('R11 gaps, pinned as today under mode off', () => {
  it('admits a spawn under a policy-seat name an adopted session holds across a broker restart', async () => {
    adoptedAcrossRestart(SEAT)

    expect((await spawnSeat()).ok).toBe(true)
  })

  it('admits a hand-started register of a policy-seat name while its launched holder is detached', async () => {
    await detachedLaunch()

    expect(core.register(newConn(), frame(SEAT, 'session-hand-2')).ok).toBe(true)
  })

  it('still refuses a spawn under a name an attached adopted session holds, via the registry', async () => {
    expect(core.register(newConn(), frame(SEAT, 'session-hand-1')).ok).toBe(true)

    expect((await spawnSeat()).reason).toMatch(/already registered as "lantern-steward"/)
  })

  it('logs nothing', async () => {
    const spy = vi.spyOn(log, 'logEvent')
    adoptedAcrossRestart(SEAT)

    await spawnSeat()

    expect(wouldRefuseRows(spy)).toEqual([])
  })
})

describe('mode shadow', () => {
  it('admits the spawn an adopted holder would block and logs one would_refuse row', async () => {
    setMode('shadow')
    const spy = vi.spyOn(log, 'logEvent')
    const holder = adoptedAcrossRestart(SEAT)

    const outcome = await spawnSeat()

    expect(outcome.ok).toBe(true)
    expect(wouldRefuseRows(spy)).toEqual([{ name: SEAT, holder, request: 'spawn' }])
  })

  it('leaves the spawn outcome as mode off gives it', async () => {
    adoptedAcrossRestart(SEAT)
    const off = await spawnSeat()
    sup.close()
    fs.rmSync(path.join(home, 'events.db'))
    events = new EventLog(path.join(home, 'events.db'))
    core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
    stopAutoAttach()
    stopAutoAttach = autoAttach(core)
    start()
    setMode('shadow')
    adoptedAcrossRestart(SEAT)

    const shadow = await spawnSeat()

    expect({ ok: shadow.ok, reason: shadow.reason }).toEqual({ ok: off.ok, reason: off.reason })
  })

  it('admits a hand-started register of a held seat and logs it', async () => {
    setMode('shadow')
    const spy = vi.spyOn(log, 'logEvent')
    const holder = await detachedLaunch()

    expect(core.register(newConn(), frame(SEAT, 'session-hand-2')).ok).toBe(true)
    expect(wouldRefuseRows(spy)).toEqual([{ name: SEAT, holder, request: 'register-adopted' }])
  })
})

describe('mode enforce', () => {
  beforeEach(() => setMode('enforce'))

  // Catches: dropping adopted identities from seatHolders.
  it('refuses the spawn an adopted holder blocks, naming the holder', async () => {
    const holder = adoptedAcrossRestart(SEAT)

    const outcome = await spawnSeat()

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(`seat name held by ${holder}`)
  })

  it('refuses a hand-started register while the launched holder is detached', async () => {
    const holder = await detachedLaunch()

    const result = core.register(newConn(), frame(SEAT, 'session-hand-2'))

    expect(result).toEqual({ ok: false, reason: `seat name held by ${holder}` })
  })

  it('lets the launched holder itself register again', async () => {
    const holder = await detachedLaunch()

    expect(core.register(newConn(), frame(SEAT, 'session-launch', holder)).ok).toBe(true)
  })

  it('admits a teleport successor, and refuses a second identity that is not one', async () => {
    const holder = await detachedLaunch()
    mintUnderSeat('successor-1', holder)
    mintUnderSeat('stranger-1')

    const stranger = core.register(newConn(), frame(SEAT, 'session-other', 'stranger-1'))

    expect(stranger).toEqual({ ok: false, reason: `seat name held by ${holder}` })
    expect(core.register(newConn(), frame(SEAT, 'session-teleport', 'successor-1')).ok).toBe(true)
  })

  it('never checks a name that is not a policy seat', async () => {
    const spy = vi.spyOn(log, 'logEvent')
    adoptedAcrossRestart('plain-scout')

    expect((await spawnSeat('plain-scout')).ok).toBe(true)
    expect(wouldRefuseRows(spy)).toEqual([])
  })
})

describe('singleInstanceVerdict', () => {
  const base = { name: SEAT, isPolicySeat: true, holders: [{ agentId: 'held-1' }], request: 'spawn' as const }

  it('refuses a policy seat another identity holds', () => {
    expect(singleInstanceVerdict(base)).toEqual({
      verdict: 'refuse',
      reason: 'seat name held by held-1',
      holder: 'held-1',
    })
  })

  it('admits the holder itself, a teleport hand-over, and a name that is no policy seat', () => {
    expect(singleInstanceVerdict({ ...base, request: 'register-agentId', self: 'held-1' }).verdict).toBe(
      'admit',
    )
    expect(
      singleInstanceVerdict({ ...base, request: 'register-agentId', teleportFrom: 'held-1' }).verdict,
    ).toBe('admit')
    expect(singleInstanceVerdict({ ...base, isPolicySeat: false }).verdict).toBe('admit')
  })
})
