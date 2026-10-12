import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatePool, spendSince } from '../agents/burndown/budget-gate.js'
import { EMPTY_LEDGER, type Ledger } from '../agents/burndown/ledger.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { readInitiatives } from '../agents/burndown/source.js'

/** CC-1080: samples read from another pool's account never join the series, so a cross-pool drop is no reset. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const HOUR = 3_600_000
const NOW = new Date(2026, 8, 29, 10)
const DAY_START = new Date(2026, 8, 29, 7).getTime()
const OLD_DIR = '/accounts/personal'

let root: string

function deps(sevenDay: number): SeatTickDeps {
  return {
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay, fiveHour: 10, ageSeconds: 30 } }),
    meters: () => ({}),
  }
}

const oldPoolSamples = [
  { at: DAY_START - 5 * HOUR, sevenDay: 55 },
  { at: DAY_START - 4 * HOUR, sevenDay: 47 },
  { at: DAY_START - 3 * HOUR, sevenDay: 56 },
]

function stateAfter(previous: Record<string, unknown>) {
  const ledger = { seats: { 'seat-a': previous } } as unknown as Ledger
  const { loaded } = loadSeats(['seat-a'], ledger, deps(22))
  return loaded[0]!
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-tick-switch-'))
  fs.cpSync(FIXTURE, root, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a seat that changed billing pool', () => {
  it('drops the old pool samples and counts only the new pool spend', () => {
    const seat = stateAfter({ samples: oldPoolSamples, configDir: OLD_DIR })
    const history = [...seat.budget.history, { at: DAY_START - HOUR, sevenDay: 14 }]
    expect(seat.budget.history).toEqual([])
    expect(spendSince(history, DAY_START, { at: NOW.getTime(), sevenDay: 22 })).toBe(8)
    expect(seat.state.configDir).toBe(seat.dispatch.configDir)
  })

  it('drops samples a ledger without a pool key holds, since their pool is unknown', () => {
    expect(stateAfter({ samples: oldPoolSamples }).budget.history).toEqual([])
  })

  it('keeps the samples of an unchanged pool', () => {
    const first = stateAfter({ samples: [] })
    const seat = stateAfter({ samples: oldPoolSamples, configDir: first.dispatch.configDir })
    expect(seat.budget.history).toHaveLength(3)
  })
})

/** CC-1145: under `poolPick: enforce` the tick gates and bills the first open pool, not only the seat's home. */

interface PoolNow {
  sevenDay: number
  fiveHour: number
  /** Points spent since 07:00, from the pool's saved day meter; absent, no day meter was saved. */
  daySpent?: number
}

const DIRS: Record<string, string> = {
  '/tmp/pool-x': 'pool-x',
  '/tmp/pool-y': 'pool-y',
  '/tmp/pool-z': 'pool-z',
}
const RUN_START = NOW.getTime() - HOUR

const HOME_AT_DAY_STOP: PoolNow = { sevenDay: 40, fiveHour: 10, daySpent: 13 }
const OPEN: PoolNow = { sevenDay: 40, fiveHour: 10, daySpent: 2 }
const FIVE_HOUR_STOP: PoolNow = { sevenDay: 40, fiveHour: 90, daySpent: 2 }
const SEVEN_DAY_STOP: PoolNow = { sevenDay: 95, fiveHour: 10, daySpent: 2 }

function pickDeps(
  pools: Record<string, PoolNow>,
  pick?: { mode: 'off' | 'shadow' | 'enforce'; order: string[] },
): SeatTickDeps {
  const at = (dir: string): PoolNow => pools[DIRS[dir] ?? ''] ?? OPEN
  return {
    autonomyRoot: root,
    root,
    now: NOW,
    reading: dir => ({ reading: { sevenDay: at(dir).sevenDay, fiveHour: at(dir).fiveHour, ageSeconds: 30 } }),
    meters: (_seat, pool) => {
      const { sevenDay, daySpent } = pools[pool] ?? OPEN
      const run = { since: RUN_START, last: sevenDay, spent: 0 }
      return daySpent === undefined
        ? { run }
        : { run, day: { since: DAY_START, last: sevenDay, spent: daySpent } }
    },
    ...(pick === undefined ? {} : { poolPick: () => pick }),
  }
}

function load(pools: Record<string, PoolNow>, pick?: Parameters<typeof pickDeps>[1]) {
  const { loaded, skipped } = loadSeats(['seat-a'], { ...EMPTY_LEDGER }, pickDeps(pools, pick))
  expect(skipped).toEqual([])
  return loaded[0]!
}

const enforce = (order: string[]) => ({ mode: 'enforce' as const, order })

describe('the tick bills the first open pool under poolPick enforce', () => {
  beforeEach(() => {
    const charter = path.join(root, 'charter.md')
    const pool =
      '  pool-z: {config_dir: /tmp/pool-z, human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80}\n'
    fs.writeFileSync(
      charter,
      fs.readFileSync(charter, 'utf8').replace(/(\n {2}pool-y:[^\n]*\n)/, `$1${pool}`),
    )
    const seat = path.join(root, 'seats', 'seat-a.md')
    fs.writeFileSync(
      seat,
      fs.readFileSync(seat, 'utf8').replace('pool: pool-x\n', 'pool: pool-x\noverflow_pool: pool-z\n'),
    )
  })

  it('dispatches on a funded behind-pace pool when home is at its per-day stop', () => {
    const seat = load({ 'pool-x': HOME_AT_DAY_STOP, 'pool-y': OPEN }, enforce(['pool-y']))

    expect(seat.dispatch.pool.name).toBe('pool-y')
    expect(seat.dispatch.configDir).toBe('/tmp/pool-y')
    expect(gatePool(seat.budget)).toMatchObject({ open: true, pool: 'pool-y' })
    expect(seat.closedPools).toBeUndefined()
  })

  it('keeps sampling home after billing another pool', () => {
    const seat = load({ 'pool-x': HOME_AT_DAY_STOP, 'pool-y': OPEN }, enforce(['pool-y']))

    expect(seat.state.configDir).toBe('/tmp/pool-x')
  })

  it('fails closed on home naming every pool when every candidate is past a stop', () => {
    const pools = { 'pool-x': HOME_AT_DAY_STOP, 'pool-y': FIVE_HOUR_STOP, 'pool-z': SEVEN_DAY_STOP }
    const seat = load(pools, enforce(['pool-y']))

    expect(seat.dispatch.pool.name).toBe('pool-x')
    expect(gatePool(seat.budget).open).toBe(false)
    for (const name of ['pool-x', 'pool-y', 'pool-z']) expect(seat.closedPools).toContain(`pool ${name}:`)
  })

  it('holds a non-home pool to its own day cap and not the seat spend caps', () => {
    const overSeatCaps = { ...OPEN, daySpent: 10 }
    const atPoolCap = { ...OPEN, daySpent: 18 }

    const open = load({ 'pool-x': HOME_AT_DAY_STOP, 'pool-y': overSeatCaps }, enforce(['pool-y']))
    const shut = load(
      { 'pool-x': HOME_AT_DAY_STOP, 'pool-y': atPoolCap, 'pool-z': SEVEN_DAY_STOP },
      enforce(['pool-y']),
    )

    expect(open.dispatch.pool.name).toBe('pool-y')
    expect(shut.closedPools).toContain(
      "pool pool-y: day spend 18 points since 07:00 at or above the pool pool-y's",
    )
  })

  it('applies the seat spend caps on home', () => {
    const overSeatDay = { ...OPEN, daySpent: 10 }
    const seat = load(
      { 'pool-x': overSeatDay, 'pool-y': SEVEN_DAY_STOP, 'pool-z': SEVEN_DAY_STOP },
      enforce([]),
    )

    expect(seat.closedPools).toContain('pool pool-x: day spend 10 points')
  })

  it('fails closed on a non-home pool with a day cap and no saved day meter', () => {
    const unmetered = { sevenDay: 40, fiveHour: 10 }
    const seat = load(
      { 'pool-x': HOME_AT_DAY_STOP, 'pool-y': unmetered, 'pool-z': SEVEN_DAY_STOP },
      enforce(['pool-y']),
    )

    expect(seat.dispatch.pool.name).toBe('pool-x')
    expect(seat.closedPools).toContain(
      'pool pool-y: no seven_day reading at or before 07:00, so day spend unknown',
    )
  })

  it('bills the overflow pool when the pick is empty and home is closed', () => {
    const seat = load({ 'pool-x': HOME_AT_DAY_STOP, 'pool-z': OPEN }, enforce([]))

    expect(seat.dispatch.pool.name).toBe('pool-z')
    expect(seat.dispatch.configDir).toBe('/tmp/pool-z')
  })

  it('leaves a seat unchanged in shadow mode', () => {
    const pools = { 'pool-x': HOME_AT_DAY_STOP, 'pool-y': OPEN }

    const shadow = load(pools, { mode: 'shadow', order: ['pool-y'] })

    expect(shadow).toEqual(load(pools))
    expect(shadow.dispatch.pool.name).toBe('pool-x')
    expect(gatePool(shadow.budget).open).toBe(false)
  })

  it('refuses budget tasks with every closed pool named', () => {
    writeTask(root)
    const pools = { 'pool-x': HOME_AT_DAY_STOP, 'pool-y': FIVE_HOUR_STOP, 'pool-z': SEVEN_DAY_STOP }
    const seat = load(pools, enforce(['pool-y']))

    const plan = planSeats(
      [seat],
      { ledger: EMPTY_LEDGER, initiatives: readInitiatives(root), scopeTagAliases: {} },
      root,
    )

    expect(plan.dispatch).toEqual([])
    expect(plan.refusals).toContainEqual(
      expect.objectContaining({ kind: 'budget', reason: seat.closedPools }),
    )
  })

  it('dispatches on the open pool through planSeats', () => {
    writeTask(root)
    const seat = load({ 'pool-x': HOME_AT_DAY_STOP, 'pool-y': OPEN }, enforce(['pool-y']))

    const plan = planSeats(
      [seat],
      { ledger: EMPTY_LEDGER, initiatives: readInitiatives(root), scopeTagAliases: {} },
      root,
    )

    expect(plan.dispatch.map(d => [d.task, d.account])).toEqual([['AA-1', 'pool-y']])
  })
})

function writeTask(dir: string): void {
  fs.mkdirSync(path.join(dir, 'init-alpha', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
  fs.writeFileSync(
    path.join(dir, 'init-alpha', 'tasks', 'AA-1.yml'),
    'id: AA-1\ntitle: task AA-1\npriority: 1\nseverity: high\nestimate: 2\n' +
      'done_when: The widget renders.\nstatus: open\ntags: []\nnotes: ""\n' +
      'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
  )
}
