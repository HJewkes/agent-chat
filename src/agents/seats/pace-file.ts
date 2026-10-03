import fs from 'node:fs'
import path from 'node:path'
import { home } from '../../paths.js'

/**
 * CC-606: the seat watchdog's `pace.json` as the broker's pool pick reads it.
 * The watchdog pass owns the file and every field not named here; this is the read half of that interface.
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

/** An ISO string, epoch ms or epoch seconds, as epoch ms. */
function toMs(value: unknown): number | undefined {
  if (typeof value === 'string') return finite(Date.parse(value))
  const n = finite(value)
  if (n === undefined) return undefined
  return n < 1e12 ? n * 1000 : n
}

function poolRow(raw: unknown): PacePool | undefined {
  if (!isRecord(raw) || !isRecord(raw.reading)) return undefined
  const behind = finite(raw.behind)
  const readingAt = toMs(raw.reading.at)
  if (behind === undefined || readingAt === undefined) return undefined
  const fiveHour = finite(raw.reading.five_hour)
  const resetsAt = toMs(raw.resets_at)
  return {
    behind,
    readingAt,
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

/** A row that does not parse is left out, so the pick skips that pool rather than the whole file. */
export function parsePace(text: string): PaceRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { found: false, reason: 'pace.json is not JSON' }
  }
  if (!isRecord(parsed) || !isRecord(parsed.pools)) return { found: false, reason: 'pace.json has no pools' }
  const rows = Object.entries(parsed.pools).flatMap(([name, raw]) => {
    const row = poolRow(raw)
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
