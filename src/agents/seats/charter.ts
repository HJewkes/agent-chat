import os from 'node:os'
import path from 'node:path'
import { frontmatterField, listField } from '../active-work.js'
import type { AccountRule } from '../burndown/budget-gate.js'

/** One billing pool from the autonomy charter's `pools:` map. */
export interface Pool {
  name: string
  configDir: string
  rule: AccountRule
}

/** What the watchdog needs from `seats/<seat>.md`. */
export interface Seat {
  name: string
  prefix: string
  pool: string
}

const frontmatter = (text: string): string => {
  if (!text.startsWith('---\n')) return ''
  const end = text.indexOf('\n---\n', 3)
  return end === -1 ? '' : text.slice(4, end)
}

const expandHome = (p: string, home: string): string =>
  p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p

/** `{a: 1, b: /x}` into its pairs; values are unquoted scalars, which is all the charter writes here. */
function flowMap(inner: string): Record<string, string> {
  const pairs = inner.split(',').map(part => /^\s*([\w-]+):\s*(.*?)\s*$/.exec(part))
  return Object.fromEntries(pairs.flatMap(m => (m?.[1] === undefined ? [] : [[m[1], m[2] ?? '']])))
}

function poolFrom(name: string, fields: Record<string, string>, home: string): Pool | undefined {
  const reserve = Number(fields.reserve_seven_day)
  const ceiling = Number(fields.ceiling_five_hour)
  const night = Number(fields.night_reserve_seven_day)
  if (fields.config_dir === undefined || !Number.isFinite(reserve) || !Number.isFinite(ceiling))
    return undefined
  return {
    name,
    configDir: expandHome(fields.config_dir, home),
    rule: {
      reserve_seven_day: reserve,
      ceiling_five_hour: ceiling,
      ...(Number.isFinite(night) ? { night: { reserve_seven_day: night } } : {}),
    },
  }
}

/** The charter's pools, keyed by name. A pool missing a config dir or a stop is dropped, which closes its gate. */
export function parsePools(charter: string, home = os.homedir()): Map<string, Pool> {
  const lines = frontmatter(charter).split('\n')
  const start = lines.findIndex(line => /^pools:/.test(line))
  const pools = new Map<string, Pool>()
  if (start === -1) return pools
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break
    const entry = /^\s+([\w-]+):\s*\{(.*)\}/.exec(line)
    const pool = entry?.[1] === undefined ? undefined : poolFrom(entry[1], flowMap(entry[2] ?? ''), home)
    if (pool !== undefined) pools.set(pool.name, pool)
  }
  return pools
}

export const charterSeats = (charter: string): string[] => listField(frontmatter(charter), 'seats')

export function parseSeat(name: string, seatFile: string): Seat | undefined {
  const prefix = frontmatterField(seatFile, 'prefix')
  const pool = frontmatterField(seatFile, 'pool')
  return prefix === undefined || pool === undefined ? undefined : { name, prefix, pool }
}
