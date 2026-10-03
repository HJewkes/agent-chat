import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../broker/core.js'
import type { Pool, Seat } from '../agents/seats/charter.js'
import type { PaceRead } from '../agents/seats/pace-file.js'
import type { PoolPick, PoolPickMode } from '../agents/seats/pool-pick.js'
import {
  readPoolPick,
  routePool,
  trustsCwd,
  type PoolPickRead,
  type PoolPickReadDeps,
  type PoolPickRequest,
} from '../agents/seats/pool-route.js'
import type { SeatSpawnRequest } from '../agents/seats/spawn-gate-read.js'
import { transcriptPath } from '../agents/transcript.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

const NOON = new Date(2026, 0, 5, 12, 0)

const pool = (name: string): Pool => ({
  name,
  configDir: `/synthetic/${name}`,
  humanUses: false,
  rule: { reserve_seven_day: 14, ceiling_five_hour: 85 },
})

const ALPHA = pool('alpha')
const BETA = pool('beta')
const GAMMA = pool('gamma')

const picked = (order: string[], reason = 'beta is most behind pace (12)'): PoolPick => ({
  order,
  reason,
  candidates: order.map(name => ({ pool: name, behind: name === 'beta' ? 12 : 2 })),
})

const read = (order: string[], reason?: string): Extract<PoolPickRead, { kind: 'pick' }> => ({
  kind: 'pick',
  seat: 'alpha-coord',
  home: 'alpha',
  pools: [ALPHA, BETA, GAMMA],
  pick: picked(order, reason),
})

const closedAt =
  (...dirs: string[]) =>
  (configDir: string): string | undefined =>
    dirs.includes(configDir) ? `${path.basename(configDir)} is past its stop` : undefined

describe('routing a pick past the budget gate', () => {
  it('redirects to the next pool when the first choice is closed', () => {
    const route = routePool(read(['beta', 'gamma', 'alpha']), 'enforce', closedAt(BETA.configDir))

    expect(route.redirect).toEqual(GAMMA)
    expect(route.refusal).toBeUndefined()
    expect(route.record.chosen).toBe('gamma')
    expect(route.record.candidates).toContainEqual({
      pool: 'beta',
      behind: 12,
      skip: 'beta is past its stop',
    })
  })

  it('refuses only when every eligible pool is closed, naming each', () => {
    const route = routePool(read(['beta', 'alpha']), 'enforce', closedAt(BETA.configDir, ALPHA.configDir))

    expect(route.redirect).toBeUndefined()
    expect(route.refusal).toBe(
      'every eligible pool is closed: beta: beta is past its stop; alpha: alpha is past its stop',
    )
  })

  it('redirects nowhere when the pick is the home pool', () => {
    const route = routePool(read(['alpha', 'beta']), 'enforce', closedAt())

    expect(route).toEqual({ record: expect.objectContaining({ chosen: 'alpha', would: false }) })
  })

  it('records the choice in shadow mode and neither redirects nor refuses', () => {
    const open = routePool(read(['beta', 'alpha']), 'shadow', closedAt())
    const shut = routePool(read(['beta', 'alpha']), 'shadow', closedAt(BETA.configDir, ALPHA.configDir))

    expect(open).toEqual({ record: expect.objectContaining({ chosen: 'beta', would: true, home: 'alpha' }) })
    expect(shut).toEqual({ record: expect.objectContaining({ chosen: null, would: true }) })
  })

  it('leaves a spawn with no eligible pool to today’s gate', () => {
    const route = routePool(read([], 'pace.json is missing'), 'enforce', closedAt(ALPHA.configDir))

    expect(route).toEqual({
      record: expect.objectContaining({ chosen: null, reason: 'pace.json is missing' }),
    })
  })
})

const CHARTER = [
  '---',
  'seats: [alpha-coord]',
  'human_only_initiatives: [family]',
  'funds:',
  '  default: [alpha, beta, gamma]',
  '  private-work: [gamma]',
  'pools:',
  '  alpha: {config_dir: /synthetic/alpha, reserve_seven_day: 14, ceiling_five_hour: 100}',
  '  beta: {config_dir: /synthetic/beta, reserve_seven_day: 14, ceiling_five_hour: 100}',
  '  gamma: {config_dir: /synthetic/gamma, reserve_seven_day: 14, ceiling_five_hour: 100}',
  '---',
  '# Charter',
].join('\n')

const seatFile = (extra: string[] = []): string =>
  ['---', 'prefix: ac', 'pool: alpha', ...extra, '---', '# Seat'].join('\n')

describe('reading the pool pick for a spawn', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const root = (seat = seatFile()): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-route-'))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, 'seats'))
    fs.writeFileSync(path.join(dir, 'charter.md'), CHARTER)
    fs.writeFileSync(path.join(dir, 'seats', 'alpha-coord.md'), seat)
    return dir
  }

  const row = (behind: number) => ({ behind, readingAt: NOON.getTime() - 60_000, fiveHour: 20 })
  const pace: PaceRead = {
    found: true,
    pools: new Map([
      ['alpha', row(2)],
      ['beta', row(12)],
      ['gamma', row(7)],
    ]),
  }
  const deps = (over: Partial<PoolPickReadDeps> = {}): PoolPickReadDeps => ({
    readPace: () => pace,
    trusted: () => true,
    home: '/synthetic',
    ...over,
  })
  const spawn = (over: Partial<PoolPickRequest> = {}): PoolPickRequest => ({
    name: 'ac-task',
    spawner: 'alpha-coord',
    homeDir: '/synthetic/alpha',
    pinned: false,
    cwd: '/synthetic/work',
    now: NOON,
    ...over,
  })

  it('picks the pool most behind for a seat’s spawn and names its home pool', () => {
    const got = readPoolPick(root(), spawn(), deps())

    expect(got).toMatchObject({ kind: 'pick', seat: 'alpha-coord', home: 'alpha' })
    expect(got.kind === 'pick' && got.pick.order).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('reads a spawn no charter seat owns as none', () => {
    expect(readPoolPick(root(), spawn({ name: 'zz-task' }), deps())).toEqual({ kind: 'none' })
  })

  it('reads a seat the charter does not list as none, unless its role is attended', () => {
    const unlisted = (seat: string): string => {
      const dir = root()
      fs.writeFileSync(path.join(dir, 'seats', 'zeta-coord.md'), seat)
      return dir
    }
    const seat = (role: string) => ['---', 'prefix: zc', 'pool: alpha', `role: ${role}`, '---'].join('\n')

    expect(readPoolPick(unlisted(seat('product')), spawn({ name: 'zc-task' }), deps())).toEqual({
      kind: 'none',
    })
    expect(readPoolPick(unlisted(seat('attended')), spawn({ name: 'zc-task' }), deps()).kind).toBe('pick')
  })

  it('keeps the pick inside the seat file’s pools list', () => {
    const got = readPoolPick(root(seatFile(['pools: [alpha, gamma]'])), spawn(), deps())

    expect(got.kind === 'pick' && got.pick.order).toEqual(['gamma', 'alpha'])
  })

  it('applies the funds map to the briefing’s initiative', () => {
    const got = readPoolPick(root(), spawn({ initiative: 'private-work' }), deps())

    expect(got.kind === 'pick' && got.pick.order).toEqual(['gamma'])
  })

  it('falls back to the seat’s own initiatives when the spawn names none', () => {
    const seat = seatFile(['initiatives:', '  open-work: 1.0', '  private-work: 0.7'])

    const got = readPoolPick(root(seat), spawn(), deps())

    expect(got.kind === 'pick' && got.pick.order).toEqual(['gamma'])
  })

  it('asks whether each pool’s config dir trusts the spawn’s cwd', () => {
    const trusted = (cwd: string, dir: string) => !(cwd === '/synthetic/work' && dir === '/synthetic/beta')

    const got = readPoolPick(root(), spawn(), deps({ trusted }))

    expect(got.kind === 'pick' && got.pick.order).toEqual(['gamma', 'alpha'])
  })

  it('routes nothing when pace.json is missing', () => {
    const readPace = (): PaceRead => ({ found: false, reason: 'pace.json is missing' })

    const got = readPoolPick(root(), spawn(), deps({ readPace }))

    expect(got.kind === 'pick' && got.pick).toEqual({
      order: [],
      reason: 'pace.json is missing',
      candidates: [],
    })
  })
})

describe('whether a pool’s config dir trusts the cwd', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  const tmp = (): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-trust-')))
    dirs.push(dir)
    return dir
  }

  it('reads a config dir whose .claude.json cannot be read as untrusted', () => {
    expect(trustsCwd(tmp(), tmp(), '/synthetic')).toBe(false)
  })

  it('reads an accepted trust entry as trusted and a missing one as untrusted', () => {
    const [cwd, other, configDir] = [tmp(), tmp(), tmp()]
    const config = { projects: { [cwd]: { hasTrustDialogAccepted: true } } }
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(config))

    expect(trustsCwd(cwd, configDir, '/synthetic')).toBe(true)
    expect(trustsCwd(other, configDir, '/synthetic')).toBe(false)
  })
})

const SEAT: Seat = { name: 'alpha-coord', prefix: 'ac', pool: 'alpha', spend: {} }

describe('agent spawn under the pool pick', () => {
  let h: RestartHarness | undefined
  const dirs: string[] = []
  afterEach(() => {
    h?.close()
    h = undefined
    vi.restoreAllMocks()
    delete process.env.CLAUDE_CONFIG_DIR
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const tmp = (label: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pool-route-${label}-`))
    dirs.push(dir)
    return dir
  }

  /** A real directory, so a redirected launch has a config dir to write under. */
  const account = (name: string): Pool => {
    return { ...pool(name), configDir: tmp(name) }
  }

  interface Setup {
    mode: PoolPickMode
    order: string[]
    /** Pools whose five_hour reading is past the ceiling. */
    closed?: string[]
    reason?: string
    /** The budget gate throws on the beta pool's config dir. */
    gateThrowsOnBeta?: boolean
  }

  const routed = ({ mode, order, closed = [], reason, gateThrowsOnBeta = false }: Setup) => {
    const beta = account('beta')
    const requests: PoolPickRequest[] = []
    const fiveHour = (dir: string) => (closed.includes(dir === beta.configDir ? 'beta' : 'alpha') ? 90 : 20)
    h = startSupervisor({
      poolPick: {
        mode: () => mode,
        read: request => {
          requests.push(request)
          const home = { ...ALPHA, configDir: request.homeDir }
          return { ...read(order, reason), pools: [home, beta] }
        },
      },
      seatBudget: {
        read: ({ configDir }: SeatSpawnRequest) => ({
          kind: 'gate' as const,
          get input() {
            if (gateThrowsOnBeta && configDir === beta.configDir) throw new Error('gate broke')
            return {
              seat: SEAT,
              pool: configDir === beta.configDir ? beta : ALPHA,
              reading: { sevenDay: 40, fiveHour: fiveHour(configDir), ageSeconds: 30 },
              now: NOON,
            }
          },
        }),
      },
    })
    return { sup: h, beta, requests }
  }

  const spawnMeta = (sup: RestartHarness, agentId: string | undefined) =>
    sup.core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)?.meta

  const pickRows = (sup: RestartHarness) =>
    sup.core.events.history(50).filter(r => r.meta.pool_pick !== undefined)

  const brokerLog = (sup: RestartHarness) => fs.readFileSync(path.join(sup.home, 'broker.log'), 'utf8')

  const request = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    profile: 'explorer',
    brief: 'pool pick',
    requestedBy: 'human',
    cwd: tmp('cwd'),
    isolation: 'none' as const,
    surface: 'headless' as const,
    ...over,
  })

  it('records the pick in shadow mode and leaves the spawn’s config_dir alone', async () => {
    const { sup, beta, requests } = routed({ mode: 'shadow', order: ['beta', 'alpha'] })

    const outcome = await sup.spawnAgent('ac-shadow')

    expect(outcome.ok).toBe(true)
    const meta = spawnMeta(sup, outcome.agentId)
    expect(meta?.config_dir).toBe(requests[0]?.homeDir)
    expect(meta?.config_dir).not.toBe(beta.configDir)
    expect(meta?.config_dir_source).toBe('broker')
    expect(pickRows(sup).map(r => [r.kind, r.text, r.meta])).toEqual([
      [
        'notice',
        'pool pick (shadow) for ac-shadow: would bill beta, home alpha: beta is most behind pace (12)',
        expect.objectContaining({
          pool_pick: 'shadow',
          would: 'true',
          chosen: 'beta',
          home: 'alpha',
          target: 'alpha-coord',
        }),
      ],
    ])
    const log = fs.readFileSync(path.join(sup.home, 'broker.log'), 'utf8')
    expect(log).toContain(
      '"event":"pool_pick","name":"ac-shadow","seat":"alpha-coord","mode":"shadow","would":true',
    )
  })

  it('still refuses on the home pool’s stop in shadow mode, though the pick is open', async () => {
    const { sup } = routed({ mode: 'shadow', order: ['beta', 'alpha'], closed: ['alpha'] })

    const outcome = await sup.spawnAgent('ac-shadow-stop')

    expect(outcome).toMatchObject({ ok: false, code: 'seat_budget_stop', retryable: true })
    expect(pickRows(sup).map(r => r.meta.chosen)).toEqual(['beta'])
  })

  it('bills the picked pool in enforce mode', async () => {
    const { sup, beta } = routed({ mode: 'enforce', order: ['beta', 'alpha'] })

    const outcome = await sup.spawnAgent('ac-enforce')

    expect(outcome.ok).toBe(true)
    const meta = spawnMeta(sup, outcome.agentId)
    expect(meta?.config_dir).toBe(beta.configDir)
    expect(meta?.config_dir_source).toBe('pool')
    expect(pickRows(sup).map(r => r.text)).toEqual([
      'pool pick (enforce) for ac-enforce: bills beta, home alpha: beta is most behind pace (12)',
    ])
  })

  it('redirects past a closed home pool in enforce mode instead of refusing', async () => {
    const { sup, beta } = routed({ mode: 'enforce', order: ['alpha', 'beta'], closed: ['alpha'] })

    const outcome = await sup.spawnAgent('ac-redirect')

    expect(outcome.ok).toBe(true)
    expect(spawnMeta(sup, outcome.agentId)?.config_dir).toBe(beta.configDir)
  })

  it('refuses in enforce mode when every eligible pool is closed', async () => {
    const { sup } = routed({ mode: 'enforce', order: ['beta', 'alpha'], closed: ['alpha', 'beta'] })

    const outcome = await sup.spawnAgent('ac-closed')

    expect(outcome).toMatchObject({ ok: false, code: 'seat_budget_stop', retryable: true })
    expect(outcome.reason).toContain('seat budget stop: every eligible pool is closed: beta: ')
    expect(outcome.reason).toContain('; alpha: ')
  })

  it('bills as before in enforce mode when the pick has no eligible pool', async () => {
    const { sup, requests } = routed({ mode: 'enforce', order: [], reason: 'pace.json is missing' })

    const outcome = await sup.spawnAgent('ac-no-pace')

    expect(outcome.ok).toBe(true)
    expect(spawnMeta(sup, outcome.agentId)?.config_dir).toBe(requests[0]?.homeDir)
    expect(pickRows(sup).map(r => r.text)).toEqual([
      expect.stringContaining('keeps alpha, home alpha: pace.json is missing'),
    ])
  })

  it('reads nothing and records nothing when the mode is off', async () => {
    const { sup, requests } = routed({ mode: 'off', order: ['beta', 'alpha'] })

    expect((await sup.spawnAgent('ac-off')).ok).toBe(true)
    expect(requests).toEqual([])
    expect(pickRows(sup)).toEqual([])
  })

  it('spawns when the pick’s reader throws, and logs the failure', async () => {
    h = startSupervisor({
      poolPick: {
        mode: () => 'enforce',
        read: () => {
          throw new Error('seats directory unreadable')
        },
      },
    })

    expect((await h.spawnAgent('ac-unread')).ok).toBe(true)
    expect(fs.readFileSync(path.join(h.home, 'broker.log'), 'utf8')).toContain('"event":"pool_pick_failed"')
  })

  it('falls back to an open home pool in enforce mode when the pick skipped it and the rest are closed', async () => {
    const { sup, requests } = routed({ mode: 'enforce', order: ['beta'], closed: ['beta'] })

    const outcome = await sup.spawnAgent('ac-home-open')

    expect(outcome.ok).toBe(true)
    expect(spawnMeta(sup, outcome.agentId)?.config_dir).toBe(requests[0]?.homeDir)
  })

  it('refuses in enforce mode when the pick skipped the home pool and it is closed too', async () => {
    const { sup } = routed({ mode: 'enforce', order: ['beta'], closed: ['alpha', 'beta'] })

    const outcome = await sup.spawnAgent('ac-home-shut')

    expect(outcome).toMatchObject({ ok: false, code: 'seat_budget_stop', retryable: true })
    expect(outcome.reason).toContain('every eligible pool is closed: beta: ')
  })

  it('keeps a pinned spawn on its config_dir in enforce mode, whatever the reader returns', async () => {
    const { sup, requests } = routed({ mode: 'enforce', order: ['beta', 'alpha'] })
    const pinnedDir = tmp('pinned')
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(pinnedDir))

    const outcome = await sup.supervisor.spawn(request('ac-pinned', { configDir: pinnedDir }))

    expect(outcome.reason).toBeUndefined()
    expect(requests.map(r => r.pinned)).toEqual([true])
    expect(spawnMeta(sup, outcome.agentId)).toMatchObject({
      config_dir: pinnedDir,
      config_dir_source: 'explicit',
    })
    expect(pickRows(sup)).toEqual([])
  })

  it('keeps a fork on its requester’s account in enforce mode and never reads the pick', async () => {
    const { sup, requests } = routed({ mode: 'enforce', order: ['beta', 'alpha'] })
    const accountDir = tmp('fork-account')
    process.env.CLAUDE_CONFIG_DIR = accountDir
    const [cwd, sessionId] = [tmp('fork-cwd'), '11111111-1111-4111-8111-000000000001']
    const conn = {} as unknown as net.Socket as Conn
    sup.core.register(conn, { t: 'register', name: 'alpha-coord', workingOn: '', cwd, pid: 1, sessionId })
    const transcript = transcriptPath(cwd, sessionId, accountDir)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '{}\n')

    const outcome = await sup.supervisor.spawn(
      request('ac-fork', { requestedBy: 'alpha-coord', cwd, inherit: 'context' }),
    )

    expect(outcome.reason).toBeUndefined()
    expect(requests).toEqual([])
    expect(spawnMeta(sup, outcome.agentId)).toMatchObject({ config_dir: accountDir, inherit: 'context' })
  })

  it('keeps a resumed session on its account in enforce mode and never reads the pick', async () => {
    const { sup, requests } = routed({ mode: 'enforce', order: ['beta', 'alpha'] })
    const [accountDir, cwd] = [tmp('resume-account'), tmp('resume-cwd')]
    const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const transcript = transcriptPath(cwd, sessionId, accountDir)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '{}\n')

    const outcome = await sup.supervisor.spawn(
      request('ac-resume', { cwd, spawnerConfigDir: accountDir, resumeSession: sessionId }),
    )

    expect(outcome.reason).toBeUndefined()
    expect(requests).toEqual([])
    expect(spawnMeta(sup, outcome.agentId)?.config_dir).toBe(accountDir)
  })

  it('spawns on the original account in shadow mode when writing the pick row throws', async () => {
    const { sup, requests } = routed({ mode: 'shadow', order: ['beta', 'alpha'] })
    const append = sup.core.append.bind(sup.core)
    vi.spyOn(sup.core, 'append').mockImplementation(input => {
      if (input.meta?.pool_pick !== undefined) throw new Error('database is locked')
      return append(input)
    })

    const outcome = await sup.spawnAgent('ac-append-throws')

    expect(outcome.reason).toBeUndefined()
    expect(spawnMeta(sup, outcome.agentId)?.config_dir).toBe(requests[0]?.homeDir)
    expect(brokerLog(sup)).toContain('"event":"pool_pick_failed","name":"ac-append-throws"')
  })

  it('spawns on the original account in shadow mode when the gate throws on another pool', async () => {
    const { sup, requests } = routed({ mode: 'shadow', order: ['beta', 'alpha'], gateThrowsOnBeta: true })

    const outcome = await sup.spawnAgent('ac-gate-throws')

    expect(outcome.reason).toBeUndefined()
    expect(spawnMeta(sup, outcome.agentId)?.config_dir).toBe(requests[0]?.homeDir)
    expect(brokerLog(sup)).toContain('"event":"pool_pick_failed","name":"ac-gate-throws"')
    expect(pickRows(sup)).toEqual([])
  })
})
