import os from 'node:os'
import path from 'node:path'
import { frontmatterField, listField } from '../active-work.js'
import { SURFACE_NAMES, type SurfaceName } from '../../protocol.js'

/** A pool's two stops, both required here: a pool missing either is dropped. */
export interface PoolStops {
  reserve_seven_day: number
  ceiling_five_hour: number
  /** CC-474: still parsed from old charters, never read; the declining reserve replaced it. */
  night?: { reserve_seven_day: number }
}

/** One billing pool from the autonomy charter's `pools:` map. */
export interface Pool {
  name: string
  configDir: string
  /** Unset reads as true, which keeps the stricter five_hour ceiling while the owner may be typing. */
  humanUses: boolean
  rule: PoolStops
  /** Charter section 4's daily cap on the pool's seven_day points, counted from 07:00 local. */
  perDayPoints?: number
  /** CC-843: the pool's sonnet-only band width; unset keeps the gate's default. */
  sonnetBandPoints?: number
}

/** What the watchdog needs from `seats/<seat>.md`. */
export interface Seat {
  name: string
  prefix: string
  pool: string
  spend: SeatSpend
  /** CC-404: `reset-aware` paces the day stop to the seven_day reset; anything else keeps `per_day_points`. */
  pacing?: string
}

/** The seat file's `spend:` block; either stop may be absent. */
export interface SeatSpend {
  perRunPoints?: number
  perDayPoints?: number
}

/** A seat name reaches file paths, so only a plain slug is a seat. */
export const isSeatName = (name: string): boolean => /^[a-z0-9][a-z0-9_-]*$/i.test(name)

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
  const perDay = Number(fields.per_day_points)
  const band = fields.sonnet_band_points === undefined ? NaN : Number(fields.sonnet_band_points)
  if (fields.config_dir === undefined || !Number.isFinite(reserve) || !Number.isFinite(ceiling))
    return undefined
  return {
    name,
    configDir: expandHome(fields.config_dir, home),
    humanUses: fields.human_uses !== 'false',
    rule: {
      reserve_seven_day: reserve,
      ceiling_five_hour: ceiling,
      ...(Number.isFinite(night) ? { night: { reserve_seven_day: night } } : {}),
    },
    ...(Number.isFinite(perDay) ? { perDayPoints: perDay } : {}),
    ...(Number.isFinite(band) && band >= 0 ? { sonnetBandPoints: band } : {}),
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

export const charterOwnerSeat = (charter: string): string | undefined =>
  frontmatterField(charter, 'owner_seat')

/** The indented `key: number` lines under a top-level `block:` in the frontmatter. */
function nestedNumbers(text: string, block: string): Record<string, number> {
  const lines = frontmatter(text).split('\n')
  const start = lines.findIndex(line => line.startsWith(`${block}:`))
  const found: Record<string, number> = {}
  if (start === -1) return found
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break
    const m = /^\s+([\w-]+):\s*([\d.]+)/.exec(line)
    if (m?.[1] !== undefined) found[m[1]] = Number(m[2])
  }
  return found
}

function parseSpend(seatFile: string): SeatSpend {
  const spend = nestedNumbers(seatFile, 'spend')
  return {
    ...(spend.per_run_points === undefined ? {} : { perRunPoints: spend.per_run_points }),
    ...(spend.per_day_points === undefined ? {} : { perDayPoints: spend.per_day_points }),
  }
}

export function parseSeat(name: string, seatFile: string): Seat | undefined {
  const prefix = frontmatterField(seatFile, 'prefix')
  const pool = frontmatterField(seatFile, 'pool')
  if (prefix === undefined || pool === undefined) return undefined
  const pacing = frontmatterField(seatFile, 'pacing')
  return { name, prefix, pool, spend: parseSpend(seatFile), ...(pacing === undefined ? {} : { pacing }) }
}

/** CC-441: the seat file's `surface:`, the one record a headless resume cannot overwrite. */
export function seatSurface(seatFile: string | undefined): SurfaceName | undefined {
  const declared = seatFile === undefined ? undefined : frontmatterField(seatFile, 'surface')
  return SURFACE_NAMES.find(name => name === declared)
}

/** A `key: [a, b]` flow list in the frontmatter, which may wrap over lines; absent reads as undefined. */
function flowList(text: string, key: string): string[] | undefined {
  const inner = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(frontmatter(text))?.[1]
  if (inner === undefined) return undefined
  return inner
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
}

/** CC-606: which pools may pay for an initiative's work. `fallback` covers every initiative `only` does not name. */
export interface FundsMap {
  only: Map<string, string[]>
  fallback?: string[]
  /** Initiatives no pool pays for. */
  never: string[]
}

/** The charter's `funds:` block of `initiative: [pool, ...]` lines, where `default` is the fallback; undefined without the block. */
export function parseFunds(charter: string): FundsMap | undefined {
  const lines = frontmatter(charter).split('\n')
  const start = lines.findIndex(line => /^funds:/.test(line))
  if (start === -1) return undefined
  const only = new Map<string, string[]>()
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break
    const entry = /^\s+([\w-]+):\s*\[(.*?)\]/.exec(line)
    if (entry?.[1] === undefined) continue
    const pools = (entry[2] ?? '').split(',').map(item => item.trim())
    only.set(
      entry[1],
      pools.filter(item => item !== ''),
    )
  }
  const fallback = only.get('default')
  only.delete('default')
  const never = flowList(charter, 'human_only_initiatives') ?? []
  return { only, never, ...(fallback === undefined ? {} : { fallback }) }
}

/** CC-606: the seat file's `pools:` list, the pools its spawns may bill; undefined when it names none. */
export const seatPools = (seatFile: string): string[] | undefined => flowList(seatFile, 'pools')

/** The slugs in the seat file's `initiatives:` map. */
export const seatInitiatives = (seatFile: string): string[] =>
  Object.keys(nestedNumbers(seatFile, 'initiatives'))
