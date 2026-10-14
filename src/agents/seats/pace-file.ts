import fs from 'node:fs'
import { pacePath } from './pace-pass.js'

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
  /** CC-1289: the account row's key when the row's `members` share one Anthropic account; every member reads this row. */
  account?: string
}

export type PaceRead = { found: true; pools: Map<string, PacePool> } | { found: false; reason: string }

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
  const rows = Object.entries(parsed.pools).flatMap(([name, raw]) => {
    const row = poolRow(raw, passAt)
    return row === undefined ? [] : memberRows(name, row, raw)
  })
  const accountLast = [...rows.filter(([, row]) => !row.account), ...rows.filter(([, row]) => row.account)]
  return { found: true, pools: new Map(accountLast) }
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * CC-1289: a row whose `members` name the pools on its account stands for each of them, with `account` set to the
 * row's key. The caller lets it override a member's own row left from before the account rows.
 */
function memberRows(name: string, row: PacePool, raw: unknown): (readonly [string, PacePool])[] {
  const members = isRecord(raw) ? stringList(raw.members) : []
  if (members.length === 0) return [[name, row]]
  const accountRow = { ...row, account: name }
  return [...new Set([name, ...members])].map(member => [member, accountRow] as const)
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
