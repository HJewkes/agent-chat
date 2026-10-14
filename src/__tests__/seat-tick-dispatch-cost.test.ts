import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DispatchCost } from '../agents/burndown/budget-gate.js'
import { diskDispatchCosts } from '../agents/burndown/dispatch-cost-source.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import { loadSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import type { FundsMap } from '../agents/seats/charter.js'

/** CC-1038 d: the tick charges each pool's dispatches at the cost its own history shows. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const MINUTE = 60_000
const NOW = new Date('2026-10-11T13:31:00Z')
const nowMs = NOW.getTime()

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-tick-cost-'))
  fs.cpSync(FIXTURE, root, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const costs: Record<string, DispatchCost> = {
  'pool-x': { sevenDay: 0.1, fiveHour: 0.4, basis: 'observed: pool-x' },
  'pool-y': { sevenDay: 0.2, fiveHour: 0.5, basis: 'observed: pool-y' },
}

function deps(order?: string[]): SeatTickDeps {
  const funds: FundsMap = { only: new Map(), fallback: ['pool-x', 'pool-y'], never: [] }
  return {
    autonomyRoot: root,
    root,
    now: NOW,
    reading: dir => ({
      reading: { sevenDay: 40, fiveHour: dir === '/tmp/pool-x' ? 90 : 10, ageSeconds: 30 },
    }),
    meters: () => ({
      run: { since: nowMs - 60 * MINUTE, last: 40, spent: 0 },
      day: { since: nowMs - 6 * 60 * MINUTE, last: 40, spent: 2 },
    }),
    dispatchCost: pool => costs[pool],
    ...(order === undefined ? {} : { poolPick: () => ({ mode: 'enforce' as const, order, funds }) }),
  }
}

describe('the tick attaches each pool its observed dispatch cost', () => {
  it('gives the home pool its own cost', () => {
    const { loaded } = loadSeats(['seat-a'], { ...EMPTY_LEDGER }, deps())

    expect(loaded[0]!.dispatch.pool.name).toBe('pool-x')
    expect(loaded[0]!.budget.dispatchCost).toEqual(costs['pool-x'])
  })

  it('gives a pool picked over a closed home that pool’s cost, not home’s', () => {
    const { loaded } = loadSeats(['seat-a'], { ...EMPTY_LEDGER }, deps(['pool-y']))

    expect(loaded[0]!.dispatch.pool.name).toBe('pool-y')
    expect(loaded[0]!.budget.dispatchCost).toEqual(costs['pool-y'])
  })
})

const writeLines = (file: string, lines: readonly string[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map(line => `${line}\n`).join(''))
}

const toSeconds = (minutesAgo: number): number => Math.round((nowMs - minutesAgo * MINUTE) / 1000)

const reading = (minutesAgo: number, sevenDay: number, fiveHour: number, pool = 'pool-y', resetsAt = 0) =>
  JSON.stringify({
    ts: toSeconds(minutesAgo),
    pool,
    seven_day: sevenDay,
    five_hour: fiveHour,
    resets_at: resetsAt,
    source: 'watchdog',
    age_s: 30,
  })

const dispatched = (minutesAgo: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: new Date(nowMs - minutesAgo * MINUTE).toISOString(),
    outcome: 'dispatched',
    agent: `a-${minutesAgo}`,
    by: 'broker',
    ...extra,
  })

/** Five spawns each from seat-a (home pool-x) under pool-y's config dir and from seat-b (home pool-y) with none. */
function writeHistory(seatBLines: readonly string[] = []): void {
  writeLines(path.join(root, 'pool-readings.jsonl'), [
    reading(120, 20, 10),
    reading(60, 21, 20),
    reading(30, 22, 30),
  ])
  const minutes = [40, 50, 60, 70, 80]
  writeLines(
    path.join(root, 'logs', 'seat-a', 'dispatch.jsonl'),
    minutes.map(m => dispatched(m, { config_dir: '/tmp/pool-y' })),
  )
  writeLines(path.join(root, 'logs', 'seat-b', 'dispatch.jsonl'), [
    ...minutes.map(m => dispatched(m + 5)),
    ...seatBLines,
  ])
}

describe('the observed cost read from disk', () => {
  it('bills a row with a config_dir to that dir’s pool, not its seat’s home', () => {
    writeHistory()

    const cost = diskDispatchCosts(root, nowMs)

    expect(cost('pool-y')).toMatchObject({ fiveHour: 2, sevenDay: 0.2 })
    expect(cost('pool-y')?.basis).toContain('10 spawns')
    expect(cost('pool-x')).toBeUndefined()
  })

  it('skips a malformed line and counts the rest', () => {
    writeHistory(['{not json', dispatched(45, { outcome: 'retired' })])

    expect(diskDispatchCosts(root, nowMs)('pool-y')?.basis).toContain('10 spawns')
  })

  it('has no estimate from a single reading in the window', () => {
    writeHistory()
    writeLines(path.join(root, 'pool-readings.jsonl'), [reading(30, 22, 30)])

    expect(diskDispatchCosts(root, nowMs)('pool-y')).toBeUndefined()
  })

  it('reads a seven_day drop after the row’s resets_at as a reset', () => {
    writeHistory()
    writeLines(path.join(root, 'pool-readings.jsonl'), [
      reading(120, 3, 10, 'pool-y', toSeconds(90)),
      reading(60, 1, 20),
      reading(30, 2, 30),
    ])

    expect(diskDispatchCosts(root, nowMs)('pool-y')?.basis).toContain('+2 seven_day')
  })

  it('has no estimate when the autonomy root holds neither file', () => {
    expect(diskDispatchCosts(root, nowMs)('pool-y')).toBeUndefined()
  })
})
