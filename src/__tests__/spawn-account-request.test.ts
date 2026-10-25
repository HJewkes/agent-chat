import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SpawnRequest, type SupervisorOptions } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import type { AccountUsage } from '../agents/account-budget.js'
import { DEFAULT_ROTATION } from '../agents/account-rotation.js'
import type { PoolPickRead } from '../agents/seats/pool-route.js'
import { autoAttach } from './broker-harness.js'

/**
 * TP-4214: a spawn that asks for an account by name or for the least-used one, for any role.
 * `account-rotation.test.ts` pins the pick; this file proves the spawn path resolves it before
 * billing, launches on it, and refuses before anything is allocated.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let stopAutoAttach: () => void
let realHome: string | undefined

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const liveChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

function account(name: string): string {
  const dir = path.join(process.env.HOME as string, '.claude-profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

interface Fake {
  fiveHour?: number
  stale?: boolean
  authFail?: boolean
}

const usage = (name: string, sevenDay: number, fake: Fake = {}): AccountUsage => ({
  account: name,
  config_dir: account(name),
  source: 'usage-poller',
  five_hour: fake.fiveHour === undefined ? null : { used_pct: fake.fiveHour },
  seven_day: { used_pct: sevenDay },
  age_seconds: fake.stale ? 900 : 60,
  stale: fake.stale === true,
  auth_fail: fake.authFail === true,
})

const FAKES = () => [usage('alpha', 70), usage('beta', 20, { fiveHour: 25 }), usage('gamma', 40)]

function supervisorWith(
  readings: () => AccountUsage[] = FAKES,
  extra: Partial<SupervisorOptions> = {},
  identify?: (dir: string) => string | undefined,
) {
  return new Supervisor(core, {
    ...extra,
    surface: { platform: 'linux', spawn: liveChild },
    accountRotation: {
      config: () => DEFAULT_ROTATION,
      readings,
      ...(identify === undefined ? {} : { identify }),
    },
  })
}

const spawnReq = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  name: 'pilot',
  profile: 'lead',
  brief: 'coordinate the work',
  requestedBy: 'human',
  cwd: tmp('agent-chat-ws-'),
  isolation: 'none',
  surface: 'headless',
  spawnerConfigDir: account('alpha'),
  account: 'least-used',
  ...over,
})

const spawnedRows = () => core.events.agentEvents().filter(row => row.kind === 'agent_spawned')
const childDir = (agentId: string | undefined) => readLaunchPlan(agentId as string).env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const home = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'))
  fs.writeFileSync(
    path.join(home, 'profiles', 'lead.json'),
    JSON.stringify({
      description: 'lead',
      model: 'sonnet',
      allowedTools: ['Read'],
      isolation: 'none',
      surface: 'headless',
      role: 'coordinator',
    }),
  )
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a spawn that asks for the least-used account', () => {
  it('launches a coordinator on the lowest max(five_hour, seven_day) and returns the readings', async () => {
    const sup = supervisorWith()

    const outcome = await sup.spawn(spawnReq())
    sup.close()

    expect(outcome.reason).toBeUndefined()
    expect(childDir(outcome.agentId)).toBe(account('beta'))
    expect(spawnedRows()[0]?.meta).toMatchObject({
      config_dir: account('beta'),
      config_dir_source: 'explicit',
    })
    expect(outcome.account).toBe(
      'beta (least-used; max(5h,7d): alpha 70% [5h n/a 7d 70], beta 25% [5h 25 7d 20], gamma 40% [5h n/a 7d 40])',
    )
  })

  it('keeps the pick when a seat pool route would redirect the spawn', async () => {
    const gamma = { name: 'gamma', configDir: account('gamma'), humanUses: false, rule: {} }
    const read = (): PoolPickRead => ({
      kind: 'pick',
      seat: 'pilot-seat',
      billed: 'beta',
      pools: [gamma as never],
      pick: { order: ['gamma'], reason: 'gamma is most behind pace', candidates: [] },
    })
    const sup = supervisorWith(FAKES, { poolPick: { mode: () => 'enforce', read } })

    const outcome = await sup.spawn(spawnReq())
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('beta'))
  })

  it('refuses with account_exhausted and the readings when no account qualifies, allocating nothing', async () => {
    const sup = supervisorWith(() => [
      usage('alpha', 40, { fiveHour: 95 }),
      usage('beta', 5, { stale: true }),
      usage('gamma', 10, { authFail: true }),
    ])
    const slotsBefore = sup.slotUsage()

    const outcome = await sup.spawn(spawnReq())
    const slotsAfter = sup.slotUsage()
    sup.close()

    expect(outcome).toMatchObject({ ok: false, code: 'account_exhausted', retryable: true })
    expect(outcome.reason).toContain('no account has a fresh reading under the 90% ceiling')
    expect(outcome.account).toBe(
      'none (least-used; max(5h,7d): alpha over ceiling 95% [5h 95 7d 40], beta stale 900s, gamma login failed)',
    )
    expect(spawnedRows()).toHaveLength(0)
    expect(slotsAfter).toEqual(slotsBefore)
  })

  it('breaks a tie toward the spawner’s own account', async () => {
    const sup = supervisorWith(() => [usage('alpha', 30), usage('beta', 30), usage('gamma', 50)])

    const outcome = await sup.spawn(spawnReq({ spawnerConfigDir: account('beta') }))
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('beta'))
  })

  it('refuses on another host, naming --account', async () => {
    const sup = supervisorWith()

    const outcome = await sup.spawn(
      spawnReq({
        cwd: `/Users/${os.userInfo().username}/projects/proj-a`,
        surface: 'iterm-tab',
        callerHost: 'mac-test-host',
        hostPlatform: 'darwin',
        launchesHere: true,
      }),
    )
    sup.close()

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(
      `least-used reads ${os.hostname()}'s accounts; on mac-test-host pass --account <name>`,
    )
  })

  it('refuses an account together with a config dir', async () => {
    const sup = supervisorWith()

    const outcome = await sup.spawn(spawnReq({ configDir: account('gamma') }))
    sup.close()

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'account and config_dir both name the account; pass one',
    })
  })
})

describe('a spawn that names its account', () => {
  it('launches on the named account over a lower one', async () => {
    const sup = supervisorWith()

    const outcome = await sup.spawn(spawnReq({ account: 'alpha', spawnerConfigDir: account('beta') }))
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('alpha'))
    expect(outcome.account).toMatch(/^alpha \(explicit; /)
  })

  it('refuses an unknown name and lists the known ones, with no exhausted code', async () => {
    const sup = supervisorWith()

    const outcome = await sup.spawn(spawnReq({ account: 'delta' }))
    sup.close()

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('unknown account delta; known: alpha, beta, gamma')
    expect(outcome.code).toBeUndefined()
    expect(spawnedRows()).toHaveLength(0)
  })

  it('launches on a stale account with a warning that names the reading’s age', async () => {
    const sup = supervisorWith(() => [usage('alpha', 70), usage('beta', 20, { stale: true })])

    const outcome = await sup.spawn(spawnReq({ account: 'beta' }))
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('beta'))
    expect(outcome.warnings).toContain("beta's reading is stale 900s")
  })

  it('launches on the named dir when it shares a login with an earlier one', async () => {
    const login = (dir: string) =>
      dir === account('alpha') || dir === account('beta') ? 'one-login' : undefined
    const sup = supervisorWith(FAKES, {}, login)

    const outcome = await sup.spawn(spawnReq({ account: 'beta' }))
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('beta'))
    expect(outcome.account).toMatch(/^beta \(explicit; max\(5h,7d\): beta \d+% .*gamma/)
  })

  it('passes a name through as that host’s config dir on another host', async () => {
    const sup = supervisorWith()
    const macHome = `/Users/${os.userInfo().username}`

    const outcome = await sup.spawn(
      spawnReq({
        account: 'beta',
        cwd: `${macHome}/projects/proj-a`,
        surface: 'iterm-tab',
        callerHost: 'mac-test-host',
        hostPlatform: 'darwin',
        launchesHere: true,
      }),
    )
    sup.close()

    expect(outcome.reason).toBeUndefined()
    expect(outcome.launch?.configDir).toBe(path.join(macHome, '.claude-profiles', 'beta'))
  })
})
