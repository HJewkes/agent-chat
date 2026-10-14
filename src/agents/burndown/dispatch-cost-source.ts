import fs from 'node:fs'
import path from 'node:path'
import { frontmatterField } from '../active-work.js'
import { parsePools, type Pool } from '../seats/charter.js'
import { DISPATCHED } from '../seats/dispatch-record.js'
import { readingHistoryPath } from '../seats/pace-pass.js'
import { poolForConfigDir } from '../seats/spawn-gate-read.js'
import type { DispatchCost } from './budget-gate.js'
import { observedDispatchCost, type CostReading } from './dispatch-cost.js'

/**
 * CC-1038 d: each pool's observed per-dispatch cost, from the watchdog's `pool-readings.jsonl` and every seat's
 * `logs/<seat>/dispatch.jsonl` under the autonomy root. A `dispatched` row bills the pool its `config_dir` names,
 * else its seat file's `pool:`. A line that does not parse is skipped; a file that cannot be read counts as empty.
 */

/** Each line of a jsonl file parsed as an object; a missing file is none, a malformed line is skipped. */
function jsonlRows(file: string): Record<string, unknown>[] {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line) as unknown
      return typeof row === 'object' && row !== null ? [row as Record<string, unknown>] : []
    } catch {
      return []
    }
  })
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** The pool's watchdog readings; a rolled row is an assumed 0, no measurement, so it is left out. */
function poolReadings(autonomyRoot: string): Map<string, CostReading[]> {
  const byPool = new Map<string, CostReading[]>()
  for (const row of jsonlRows(readingHistoryPath(autonomyRoot))) {
    const { ts, pool, seven_day: sevenDay, five_hour: fiveHour } = row
    if (typeof pool !== 'string' || !isNumber(ts) || !isNumber(sevenDay) || !isNumber(fiveHour)) continue
    if (row.rolled === true) continue
    pushTo(byPool, pool, { at: ts * 1000, sevenDay, fiveHour })
  }
  return byPool
}

function seatPool(autonomyRoot: string, seat: string): string | undefined {
  try {
    return frontmatterField(fs.readFileSync(path.join(autonomyRoot, 'seats', `${seat}.md`), 'utf8'), 'pool')
  } catch {
    return undefined
  }
}

interface Attribution {
  pools: ReadonlyMap<string, Pool>
  /** The seat's `pool:`, memoised; undefined when its file is missing or names none. */
  homeOf: (seat: string) => string | undefined
}

/** The pool a `dispatched` row billed: its `config_dir`'s pool when known, else its seat's home. */
function billedPool(row: Record<string, unknown>, logSeat: string, by: Attribution): string | undefined {
  const dir = row.config_dir
  if (typeof dir === 'string') {
    const pool = poolForConfigDir(by.pools, dir)
    if (pool !== undefined) return pool.name
  }
  return by.homeOf(typeof row.seat === 'string' ? row.seat : logSeat)
}

function logSeats(autonomyRoot: string): string[] {
  try {
    return fs
      .readdirSync(path.join(autonomyRoot, 'logs'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Epoch ms of every `dispatched` row under `logs/`, by the pool it billed. */
function spawnTimes(autonomyRoot: string, by: Attribution): Map<string, number[]> {
  const byPool = new Map<string, number[]>()
  for (const seat of logSeats(autonomyRoot)) {
    for (const row of jsonlRows(path.join(autonomyRoot, 'logs', seat, 'dispatch.jsonl'))) {
      if (row.outcome !== DISPATCHED || typeof row.ts !== 'string') continue
      const at = Date.parse(row.ts)
      const pool = billedPool(row, seat, by)
      if (Number.isNaN(at) || pool === undefined) continue
      pushTo(byPool, pool, at)
    }
  }
  return byPool
}

function charterPools(autonomyRoot: string): Map<string, Pool> {
  try {
    return parsePools(fs.readFileSync(path.join(autonomyRoot, 'charter.md'), 'utf8'))
  } catch {
    return new Map()
  }
}

/** Reads the files once, on the first call, and answers each pool from that read. */
export function diskDispatchCosts(
  autonomyRoot: string,
  nowMs: number,
): (pool: string) => DispatchCost | undefined {
  let read: { readings: Map<string, CostReading[]>; spawns: Map<string, number[]> } | undefined
  return pool => {
    if (read === undefined) {
      const homes = new Map<string, string | undefined>()
      const homeOf = (seat: string) => {
        if (!homes.has(seat)) homes.set(seat, seatPool(autonomyRoot, seat))
        return homes.get(seat)
      }
      const by = { pools: charterPools(autonomyRoot), homeOf }
      read = { readings: poolReadings(autonomyRoot), spawns: spawnTimes(autonomyRoot, by) }
    }
    return observedDispatchCost(read.readings.get(pool) ?? [], read.spawns.get(pool) ?? [], nowMs)
  }
}
