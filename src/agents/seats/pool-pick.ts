import type { FundsMap, Pool } from './charter.js'
import type { PacePool, PaceRead } from './pace-file.js'

/**
 * CC-606: which pool an unpinned seat spawn should bill, from the watchdog's pace file.
 * Pure: the broker reads the charter, the seat file and `pace.json` and passes them in.
 */

export const MAX_PACE_READING_AGE_MS = 15 * 60 * 1000
/** A pool this close to its five_hour ceiling is skipped, so a routed agent does not die on a 429. */
export const FIVE_HOUR_MARGIN = 10
/** Below this deficit on every pool, the home pool wins and nothing moves. */
export const BEHIND_FLOOR = 5

export const POOL_PICK_MODES = ['off', 'shadow', 'enforce'] as const
/** `shadow` computes and records the pick and bills as before; `enforce` bills the picked pool. */
export type PoolPickMode = (typeof POOL_PICK_MODES)[number]

export interface PoolPickInput {
  /** The request named a config_dir, which always wins. */
  pinned: boolean
  /** The pool the spawn bills today. */
  home: string | undefined
  /** The pools the seat may bill. */
  pools: readonly Pool[]
  funds: FundsMap | undefined
  /** The initiatives the spawn's work may belong to; a pool must be allowed to fund every one. */
  initiatives: readonly string[]
  pace: PaceRead
  /** Whether the pool's config dir trusts the spawn's cwd. */
  trusted: (pool: Pool) => boolean
  now: number
}

export interface PoolCandidate {
  pool: string
  behind?: number
  /** Why the pick left the pool out. */
  skip?: string
}

export interface PoolPick {
  /** Eligible pools, best first; empty means the spawn bills as it does today. */
  order: string[]
  reason: string
  candidates: PoolCandidate[]
}

const noRoute = (reason: string): PoolPick => ({ order: [], reason, candidates: [] })

/** The pools `funds` lets pay for all of `initiatives`; undefined is every pool. */
function fundedPools(funds: FundsMap, initiatives: readonly string[]): Set<string> | undefined {
  const lists = (
    initiatives.length === 0 ? [funds.fallback] : initiatives.map(i => funds.only.get(i) ?? funds.fallback)
  ).filter(list => list !== undefined)
  const [first, ...rest] = lists
  if (first === undefined) return undefined
  return new Set(first.filter(pool => rest.every(list => list.includes(pool))))
}

function readingSkip(pool: Pool, row: PacePool | undefined, now: number): string | undefined {
  if (row === undefined) return 'no pace row'
  const age = now - row.readingAt
  if (age > MAX_PACE_READING_AGE_MS) return `reading ${Math.round(age / 1000)}s old, over 900s`
  if (row.fiveHour === undefined) return 'no five_hour reading'
  const line = pool.rule.ceiling_five_hour - FIVE_HOUR_MARGIN
  if (row.fiveHour >= line)
    return `five_hour ${row.fiveHour}% within ${FIVE_HOUR_MARGIN} of ceiling ${pool.rule.ceiling_five_hour}%`
  return undefined
}

interface Eligible {
  pool: string
  row: PacePool
}

/** Largest deficit first; a tie goes to the earlier reset. */
const byDeficit = (a: Eligible, b: Eligible): number =>
  b.row.behind - a.row.behind || (a.row.resetsAt ?? Infinity) - (b.row.resetsAt ?? Infinity)

function ordered(eligible: Eligible[], home: string | undefined): { order: string[]; reason: string } {
  const sorted = [...eligible].sort(byDeficit)
  const order = sorted.map(e => e.pool)
  const [top] = sorted
  if (top === undefined) return { order, reason: 'no pool is eligible' }
  if (top.row.behind >= BEHIND_FLOOR)
    return { order, reason: `${top.pool} is most behind pace (${top.row.behind})` }
  if (home === undefined || !order.includes(home))
    return { order, reason: `no pool is behind by ${BEHIND_FLOOR}` }
  return {
    order: [home, ...order.filter(pool => pool !== home)],
    reason: `no pool is behind by ${BEHIND_FLOOR}, so home pool ${home} keeps the spawn`,
  }
}

/** Why `pool` cannot take the spawn, checked cheapest first; the trust read comes last. */
function skipReason(
  pool: Pool,
  row: PacePool | undefined,
  funded: Set<string> | undefined,
  input: PoolPickInput,
): string | undefined {
  if (funded !== undefined && !funded.has(pool.name)) return 'not in the funds map for this work'
  const reading = readingSkip(pool, row, input.now)
  if (reading !== undefined) return reading
  return input.trusted(pool) ? undefined : 'its config dir does not trust the cwd'
}

export function pickPool(input: PoolPickInput): PoolPick {
  const { pace, funds } = input
  if (input.pinned) return noRoute('the spawn pins config_dir')
  if (!pace.found) return noRoute(pace.reason)
  if (funds === undefined) return noRoute('the charter has no funds map')
  const humanOnly = input.initiatives.find(i => funds.never.includes(i))
  if (humanOnly !== undefined) return noRoute(`initiative ${humanOnly} is human-only`)
  const funded = fundedPools(funds, input.initiatives)
  const eligible: Eligible[] = []
  const candidates = input.pools.map((pool): PoolCandidate => {
    const row = pace.pools.get(pool.name)
    const skip = skipReason(pool, row, funded, input)
    const behind = row === undefined ? {} : { behind: row.behind }
    if (row !== undefined && skip === undefined) eligible.push({ pool: pool.name, row })
    return { pool: pool.name, ...behind, ...(skip === undefined ? {} : { skip }) }
  })
  return { ...ordered(eligible, input.home), candidates }
}
