import fs from 'node:fs'
import path from 'node:path'
import { home } from '../../paths.js'

/**
 * CC-606: the seat watchdog's `pace.json` as the broker's pool pick reads it: `{at, pools: {<name>: row}}`,
 * times in epoch ms. The watchdog pass (CC-605) owns the file; this reads four of a row's fields.
 */

/** One pool's row, with every time in epoch ms. */
export interface PacePool {
  /** Points the pool is behind its pace line; negative when ahead. */
  behind: number
  /** When the reading the row was computed from was taken. */
  readingAt: number
  fiveHour?: number
  /** When the pool's seven_day window resets. */
  resetsAt?: number
}

export type PaceRead = { found: true; pools: Map<string, PacePool> } | { found: false; reason: string }

export const pacePath = (): string => path.join(home(), 'pace.json')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The writer's row holds the reading's age at the pass, so the pass time dates the reading. */
function poolRow(raw: unknown, passAt: number): PacePool | undefined {
  if (!isRecord(raw) || raw.stale === true) return undefined
  const behind = finite(raw.behind)
  const ageSeconds = finite(raw.ageSeconds)
  if (behind === undefined || ageSeconds === undefined) return undefined
  const fiveHour = finite(raw.fiveHour)
  const resetsAt = finite(raw.resetsAt)
  return {
    behind,
    readingAt: passAt - ageSeconds * 1000,
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

/** A row that does not parse, or that the writer marked stale, is left out, so the pick skips that pool rather than the whole file. */
export function parsePace(text: string): PaceRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { found: false, reason: 'pace.json is not JSON' }
  }
  const passAt = isRecord(parsed) ? finite(parsed.at) : undefined
  if (!isRecord(parsed) || passAt === undefined || !isRecord(parsed.pools))
    return { found: false, reason: 'pace.json has no pass time or no pools' }
  const pools = parsed.pools
  const rows = Object.entries(pools).flatMap(([name, raw]) => {
    const row = poolRow(raw, passAt)
    return row === undefined ? [] : [[name, row] as const]
  })
  return { found: true, pools: new Map(rows) }
}

export function readPace(file = pacePath()): PaceRead {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { found: false, reason: 'pace.json is missing' }
  }
  return parsePace(text)
}
