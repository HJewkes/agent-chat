import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import type { Pool, Seat } from '../agents/seats/charter.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import { readSeatSpawn, type SeatSpawnReadDeps } from '../agents/seats/spawn-gate-read.js'
import { seatSpawnGate, type SeatSpawnInput } from '../agents/seats/spawn-gate.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-288: charter section 4's budget stops at agent_spawn for a seat-prefixed name. Synthetic pools and seats. */

const NOON = new Date(2026, 9, 2, 12, 0)
const DAY_START = new Date(2026, 9, 2, 7, 0).getTime()
const MIN = 60_000
const DAY = 24 * 60 * MIN

const AGENTS: Pool = {
  name: 'agents',
  configDir: '/synthetic/agents',
  humanUses: false,
  rule: { reserve_seven_day: 25, ceiling_five_hour: 85 },
  perDayPoints: 15,
}

const SHARED: Pool = {
  name: 'shared',
  configDir: '/synthetic/shared',
  humanUses: true,
  rule: { reserve_seven_day: 10, ceiling_five_hour: 85 },
}

const SEAT: Seat = { name: 'alpha-coord', prefix: 'ac', pool: 'agents', spend: { perDayPoints: 40 } }

const input = (over: Partial<SeatSpawnInput> = {}): SeatSpawnInput => ({
  seat: SEAT,
  pool: AGENTS,
  reading: { sevenDay: 40, fiveHour: 20, ageSeconds: 30 },
  dayMeter: { since: DAY_START, last: 40, spent: 0 },
  model: 'opus',
  now: NOON,
  ...over,
})

describe('the seat spawn gate', () => {
  it('allows a spawn well inside every stop, naming the reading', () => {
    const verdict = seatSpawnGate(input())

    expect(verdict).toEqual({
      allow: true,
      reason: expect.stringContaining('five_hour 20% vs ceiling 85%, seven_day 40% vs line 75%'),
    })
  })

  it('refuses at the five_hour ceiling', () => {
    const verdict = seatSpawnGate(input({ reading: { sevenDay: 40, fiveHour: 90, ageSeconds: 30 } }))

    expect(verdict).toEqual({
      allow: false,
      reason:
        'seat alpha-coord: BUDGET-PAUSE pool agents: five_hour 90% at or above ceiling 85% (no seven_day resets_at, flat reserve)',
    })
  })

  it('refuses inside the seven_day reserve', () => {
    const verdict = seatSpawnGate(input({ reading: { sevenDay: 76, fiveHour: 20, ageSeconds: 30 } }))

    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toContain('seven_day 76% at or above line 75%')
  })

  it('lifts the seat per_run_points and per_day_points on day 6 of the window (CC-474)', () => {
    const seat: Seat = { ...SEAT, spend: { perRunPoints: 3, perDayPoints: 5 } }
    const meter = { since: DAY_START, last: 40, spent: 0 }
    const onDay = (daysToReset: number) =>
      seatSpawnGate(
        input({
          seat,
          runMeter: meter,
          dayMeter: meter,
          reading: {
            sevenDay: 50,
            fiveHour: 20,
            ageSeconds: 30,
            sevenDayResetsAt: NOON.getTime() + daysToReset * DAY - MIN,
          },
        }),
      )

    const dayFive = onDay(3)
    const daySix = onDay(2)

    expect(dayFive.allow).toBe(false)
    expect(dayFive.reason).toContain("run spend 10 points at or above the seat's per_run_points 3")
    expect(daySix.allow).toBe(true)
    expect(daySix.reason).toContain('seven_day 50% vs line 92.86% (day 6 of 7, seat caps lifted)')
  })

  it("keeps the pool's per_day_points for a reset-aware seat on day 6", () => {
    const resetsAt = NOON.getTime() + 2 * DAY - MIN
    const verdict = seatSpawnGate(
      input({
        seat: { ...SEAT, pacing: 'reset-aware' },
        resetsAt,
        reading: { sevenDay: 56, fiveHour: 20, ageSeconds: 30, sevenDayResetsAt: resetsAt },
        model: 'sonnet',
      }),
    )

    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toContain(
      "day spend 16 points since 07:00 at or above the pool agents's per_day_points 15",
    )
  })

  it('keeps the R line on day 7 while the seat caps are lifted', () => {
    const reading = {
      sevenDay: 97,
      fiveHour: 20,
      ageSeconds: 30,
      sevenDayResetsAt: NOON.getTime() + DAY - MIN,
    }

    const verdict = seatSpawnGate(input({ reading }))

    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toContain('seven_day 97% at or above line 96.43% (day 7 of 7, seat caps lifted)')
  })

  it("refuses once the pool's spend since 07:00 reaches its per_day_points", () => {
    const verdict = seatSpawnGate(input({ reading: { sevenDay: 56, fiveHour: 20, ageSeconds: 30 } }))

    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toContain(
      "day spend 16 points since 07:00 at or above the pool agents's per_day_points 15",
    )
  })

  it("refuses at a reset-aware seat's day allowance, as seats status computes it", () => {
    const seat: Seat = { ...SEAT, pacing: 'reset-aware' }
    const resetsAt = DAY_START + 5 * 24 * 60 * MIN

    const verdict = seatSpawnGate(
      input({
        seat,
        resetsAt,
        dayMeter: { since: DAY_START, last: 70, spent: 0 },
        reading: { sevenDay: 73, fiveHour: 20, ageSeconds: 30, sevenDayResetsAt: resetsAt },
        model: 'sonnet',
      }),
    )

    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toContain("at or above the seat's reset-aware day allowance 2.43")
  })

  it('leaves the day caps unchecked when the watchdog has saved no day meter', () => {
    const verdict = seatSpawnGate(
      input({ dayMeter: undefined, reading: { sevenDay: 56, fiveHour: 20, ageSeconds: 30 } }),
    )

    expect(verdict.allow).toBe(true)
  })

  it('refuses opus and allows sonnet within 10 points of the ceiling', () => {
    const near = { reading: { sevenDay: 40, fiveHour: 80, ageSeconds: 30 } }

    const opus = seatSpawnGate(input({ ...near, model: 'opus' }))
    const sonnet = seatSpawnGate(input({ ...near, model: 'claude-sonnet-5-5' }))

    expect(opus.allow).toBe(false)
    expect(opus.reason).toContain('within 10 points, sonnet only; profile model opus is not sonnet')
    expect(sonnet.allow).toBe(true)
  })

  it('refuses sonnet past the ceiling itself', () => {
    const verdict = seatSpawnGate(
      input({ model: 'sonnet', reading: { sevenDay: 40, fiveHour: 86, ageSeconds: 30 } }),
    )

    expect(verdict.allow).toBe(false)
  })

  it('yields a shared pool to the owner: its ceiling drops to 70 while the owner may be typing', () => {
    const overflow = { pool: SHARED, dayMeter: undefined, model: 'sonnet' }
    const reading = { sevenDay: 40, fiveHour: 74, ageSeconds: 30 }

    const present = seatSpawnGate(input({ ...overflow, reading }))
    const away = seatSpawnGate(input({ ...overflow, reading, humanLastTurnAt: NOON.getTime() - 20 * MIN }))

    expect(present.allow).toBe(false)
    expect(present.reason).toContain(
      'BUDGET-PAUSE pool shared: five_hour 74% at or above ceiling 70% (no seven_day resets_at, flat reserve, owner typed in the last 15 min)',
    )
    expect(away.allow).toBe(true)
  })

  it('does not refuse on a missing reading', () => {
    const verdict = seatSpawnGate(input({ reading: undefined }))

    expect(verdict).toEqual({
      allow: true,
      reason: expect.stringContaining('no seven_day and five_hour reading'),
    })
  })

  it('does not refuse on a stale reading, however far past a stop', () => {
    const verdict = seatSpawnGate(input({ reading: { sevenDay: 99, fiveHour: 99, ageSeconds: 3600 } }))

    expect(verdict).toEqual({ allow: true, reason: expect.stringContaining('reading is 3600s old') })
  })
})

const CHARTER = `---
seats: [alpha-coord]
pools:
  agents: {config_dir: ~/agents, human_uses: false, reserve_seven_day: 25, ceiling_five_hour: 85, per_day_points: 15}
  shared: {config_dir: ~/shared, human_uses: true, reserve_seven_day: 10, ceiling_five_hour: 85}
---
# synthetic charter
`

const seatFile = (prefix: string, pool = 'agents'): string => `---\nprefix: ${prefix}\npool: ${pool}\n---\n`

describe('reading a seat spawn from the autonomy root', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const root = (): { root: string; home: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-spawn-gate-'))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, 'seats', 'retired'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'charter.md'), CHARTER)
    fs.writeFileSync(path.join(dir, 'seats', 'alpha-coord.md'), seatFile('ac'))
    fs.writeFileSync(path.join(dir, 'seats', 'beta-coord.md'), seatFile('bc'))
    fs.writeFileSync(path.join(dir, 'seats', 'retired', 'gamma-coord.md'), seatFile('gc'))
    return { root: dir, home: '/synthetic' }
  }

  const deps = (home: string, reads: string[] = []): SeatSpawnReadDeps => ({
    home,
    readBudget: (configDir): BudgetRead => {
      reads.push(configDir)
      return { found: false, path: configDir, reason: 'no_file' }
    },
    loadDoc: (): WatchdogDoc => ({
      seats: {},
      pools: { agents: { since: DAY_START, last: 40, spent: 0 } },
      stopped: {},
    }),
  })

  const spawn = (name: string, configDir = '/synthetic/agents') => ({
    name,
    spawner: 'alpha-coord',
    configDir,
    now: NOON,
  })

  it('leaves a name with no seat prefix to the other gates', () => {
    const { root: dir, home } = root()

    expect(readSeatSpawn(dir, spawn('worker-1'), deps(home))).toEqual({ kind: 'none' })
  })

  it('skips a seat file the charter no longer lists, and ignores a retired seat file', () => {
    const { root: dir, home } = root()

    expect(readSeatSpawn(dir, spawn('bc-task'), deps(home))).toEqual({
      kind: 'skip',
      reason: "seat beta-coord is not in the charter's seats",
    })
    expect(readSeatSpawn(dir, spawn('gc-task'), deps(home))).toEqual({ kind: 'none' })
  })

  it('gates the spawn of an attended seat the charter does not list, on any charter pool', () => {
    const { root: dir, home } = root()
    const attended =
      '---\nprefix: at\nrole: attended   # the owner works here\npool: agents\nspend: {}\n---\n'
    fs.writeFileSync(path.join(dir, 'seats', 'owner-desk.md'), attended)

    const own = readSeatSpawn(dir, spawn('at-task'), deps(home))
    const other = readSeatSpawn(dir, spawn('at-task', '/synthetic/shared'), deps(home))

    expect(own).toMatchObject({ kind: 'gate', input: { seat: { name: 'owner-desk', spend: {} } } })
    expect(other).toMatchObject({ kind: 'gate', input: { pool: { name: 'shared' } } })
  })

  it("gates on the pool of the spawn's config_dir, not the seat's own pool", () => {
    const { root: dir, home } = root()
    const reads: string[] = []

    const read = readSeatSpawn(dir, spawn('ac-task', '/synthetic/shared/'), deps(home, reads))

    expect(read).toMatchObject({ kind: 'gate', input: { pool: { name: 'shared' }, dayMeter: undefined } })
    expect(reads).toEqual(['/synthetic/shared'])
  })

  it("carries the billed pool's day meter from the watchdog doc", () => {
    const { root: dir, home } = root()

    const read = readSeatSpawn(dir, spawn('ac-task'), deps(home))

    expect(read).toMatchObject({ kind: 'gate', input: { pool: { name: 'agents' }, dayMeter: { last: 40 } } })
  })

  it('skips a config_dir that no charter pool names', () => {
    const { root: dir, home } = root()

    expect(readSeatSpawn(dir, spawn('ac-task', '/synthetic/other'), deps(home))).toEqual({
      kind: 'skip',
      reason: "seat alpha-coord: the spawn's config_dir is no charter pool's",
    })
  })
})

describe('agent spawn under the seat budget gate', () => {
  let h: RestartHarness | undefined
  afterEach(() => {
    h?.close()
    h = undefined
  })

  const gated = (fiveHour: number): RestartHarness => {
    const read = () => ({
      kind: 'gate' as const,
      input: { seat: SEAT, pool: AGENTS, reading: { sevenDay: 40, fiveHour, ageSeconds: 30 }, now: NOON },
    })
    h = startSupervisor({ seatBudget: { read } })
    return h
  }

  it('refuses a seat spawn past a stop with a retryable seat_budget_stop naming the reading', async () => {
    const sup = gated(90)

    const outcome = await sup.spawnAgent('ac-over')

    expect(outcome).toEqual({
      ok: false,
      code: 'seat_budget_stop',
      retryable: true,
      reason:
        'seat budget stop: seat alpha-coord: BUDGET-PAUSE pool agents: five_hour 90% at or above ceiling 85% (no seven_day resets_at, flat reserve)',
    })
    const refused = sup.core.events.history(20).filter(r => r.kind === 'agent_spawn_refused')
    expect(refused.map(r => r.text)).toEqual([expect.stringContaining('five_hour 90%')])
  })

  it('spawns a seat agent inside every stop', async () => {
    const sup = gated(20)

    expect((await sup.spawnAgent('ac-under')).ok).toBe(true)
  })

  it('spawns when the reader throws, and logs the failure', async () => {
    h = startSupervisor({
      seatBudget: {
        read: () => {
          throw new Error('seats directory unreadable')
        },
      },
    })

    const outcome = await h.spawnAgent('ac-unread')

    expect(outcome.ok).toBe(true)
    const log = fs.readFileSync(path.join(h.home, 'broker.log'), 'utf8')
    expect(log).toContain('"event":"seat_spawn_gate_failed"')
  })
})
