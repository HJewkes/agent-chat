import path from 'node:path'
import type { AccountUsage } from './account-budget.js'
import { accountName } from './config-dir.js'

/**
 * CC-1546: a worker spawn with no explicit `config_dir` bills the account with the most
 * seven_day headroom. Only a fresh reading can win: a stale or missing one says nothing
 * about the account now, so it never outranks a fresh one, and with no fresh reading at
 * all the spawn keeps the account CC-100 resolved. A tie keeps it too, so rotation moves
 * a spawn only for a strictly lower reading.
 *
 * Seven_day ranks the candidates, but a candidate must also pass every check that would refuse
 * the spawn on it: a five_hour window at the ceiling, and the caller's own gates (the seat budget,
 * the reviewer account gate). Each disqualifies the candidate before the pick, never after it.
 */

export interface RotationConfig {
  enabled: boolean
  /** An account at or above this used_pct, in either window, is never rotated to. */
  ceilingPct: number
  /** Account names (`default` for `~/.claude`) or absolute config dirs never rotated to. */
  exclude: readonly string[]
}

export const DEFAULT_ROTATION: RotationConfig = { enabled: true, ceilingPct: 90, exclude: [] }

export type ReadingState =
  | 'fresh'
  | 'stale'
  | 'none'
  | 'excluded'
  | 'auth_fail'
  | 'over_ceiling'
  | 'five_hour_full'
  /** Fresh, but a gate the spawn must pass refuses it on this account. */
  | 'refused'

export interface RotationReading {
  account: string
  config_dir: string
  used_pct: number | null
  state: ReadingState
}

export interface RotationRecord {
  /** The account CC-100's order resolved: the spawner's, the initiative's, or the broker's. */
  from: string
  chosen: string
  rotated: boolean
  readings: RotationReading[]
}

export interface RotationPick {
  dir: string
  record: RotationRecord
}

const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)
/** Only a fresh reading is compared, and a fresh reading always has a used_pct. */
const pct = (r: RotationReading): number => r.used_pct ?? 0

function stateOf(usage: AccountUsage, config: RotationConfig): ReadingState {
  if (config.exclude.some(entry => entry === usage.account || sameDir(entry, usage.config_dir)))
    return 'excluded'
  if (usage.auth_fail) return 'auth_fail'
  if (usage.seven_day === null) return 'none'
  if (usage.stale) return 'stale'
  if (usage.seven_day.used_pct >= config.ceilingPct) return 'over_ceiling'
  const fiveHour = usage.five_hour?.used_pct
  return fiveHour !== undefined && fiveHour >= config.ceilingPct ? 'five_hour_full' : 'fresh'
}

export const readingOf = (usage: AccountUsage, config: RotationConfig): RotationReading => ({
  account: usage.account,
  config_dir: usage.config_dir,
  used_pct: usage.seven_day?.used_pct ?? null,
  state: stateOf(usage, config),
})

/** A fresh candidate the spawn's own gates refuse is disqualified rather than chosen and then refused. */
const gated = <R extends { config_dir: string; state: ReadingState }>(
  r: R,
  refuses: (dir: string) => boolean,
): R => (r.state === 'fresh' && refuses(r.config_dir) ? { ...r, state: 'refused' } : r)

/** The lowest fresh reading wins; the resolved account keeps the spawn unless another is strictly lower. */
export function pickAccount(
  resolvedDir: string,
  usages: readonly AccountUsage[],
  config: RotationConfig,
  refuses: (dir: string) => boolean = () => false,
): RotationPick {
  const readings = usages.map(usage => gated(readingOf(usage, config), refuses))
  const fresh = readings.filter(r => r.state === 'fresh')
  const current = readings.find(r => sameDir(r.config_dir, resolvedDir))
  const lowest = fresh.reduce<RotationReading | undefined>(
    (best, r) => (best === undefined || pct(r) < pct(best) ? r : best),
    undefined,
  )
  const from = current?.account ?? accountName(resolvedDir)
  const keep = { dir: resolvedDir, record: { from, chosen: from, rotated: false, readings } }
  if (lowest === undefined) return keep
  if (current?.state === 'fresh' && pct(current) <= pct(lowest)) return keep
  return { dir: lowest.config_dir, record: { from, chosen: lowest.account, rotated: true, readings } }
}

const MEASURED_SUFFIX: Partial<Record<ReadingState, string>> = {
  fresh: '',
  over_ceiling: ' over ceiling',
  five_hour_full: ' five_hour full',
  refused: ' refused',
}

const readingText = (r: RotationReading): string => {
  const suffix = MEASURED_SUFFIX[r.state]
  if (suffix !== undefined) return `${r.account} ${Math.round(pct(r))}%${suffix}`
  return `${r.account} ${r.state === 'none' ? 'no reading' : r.state.replace('_', ' ')}`
}

/** The spawn result's account line, e.g. `agents (rotated from default; seven_day default 72%, agents 31%)`. */
export function rotationText(record: RotationRecord): string {
  const verdict = record.rotated ? `rotated from ${record.from}` : 'kept'
  return `${record.chosen} (${verdict}; seven_day ${record.readings.map(readingText).join(', ')})`
}

/**
 * TP-4213: the role-agnostic pick for a spawn that asks for the least-used account. Unlike
 * CC-1546's worker rotation it ranks by the fuller of the two windows, has no resolved account
 * to keep, and refuses rather than falling back when no reading qualifies. A caller that names
 * an account skips the ranking but not the checks that would refuse the spawn on it; a stale or
 * missing reading only warns there, since staleness says nothing bad about the account.
 */

export interface LeastUsedReading {
  account: string
  config_dir: string
  five_hour: number | null
  seven_day: number | null
  /** max(five_hour, seven_day) used_pct; null without a seven_day reading. */
  score: number | null
  age_seconds: number | null
  state: ReadingState
}

export interface LeastUsedRecord {
  mode: 'least-used' | 'explicit'
  chosen?: string
  readings: LeastUsedReading[]
  /** An explicit account launched on a reading that cannot vouch for it. */
  warning?: string
}

export type LeastUsedPick =
  { ok: true; dir: string; record: LeastUsedRecord } | { ok: false; reason: string; record: LeastUsedRecord }

export interface LeastUsedOptions {
  /** Wins a tie it is part of: the spawner's own account. */
  preferDir?: string
  /** An account name or an absolute config dir that skips the ranking. */
  explicit?: string
  refuses?: (dir: string) => boolean
}

const scoreOf = (usage: AccountUsage): number | null =>
  usage.seven_day === null ? null : Math.max(usage.seven_day.used_pct, usage.five_hour?.used_pct ?? 0)

const leastUsedReading = (usage: AccountUsage, config: RotationConfig): LeastUsedReading => ({
  account: usage.account,
  config_dir: usage.config_dir,
  five_hour: usage.five_hour?.used_pct ?? null,
  seven_day: usage.seven_day?.used_pct ?? null,
  score: scoreOf(usage),
  age_seconds: usage.age_seconds,
  state: stateOf(usage, config),
})

const score = (r: LeastUsedReading): number => r.score ?? 0

function lowestOf(
  fresh: readonly LeastUsedReading[],
  preferDir: string | undefined,
): LeastUsedReading | undefined {
  const lowest = fresh.reduce<LeastUsedReading | undefined>(
    (best, r) => (best === undefined || score(r) < score(best) ? r : best),
    undefined,
  )
  if (lowest === undefined || preferDir === undefined) return lowest
  return fresh.find(r => score(r) === score(lowest) && sameDir(r.config_dir, preferDir)) ?? lowest
}

const ageText = (r: LeastUsedReading): string => (r.age_seconds === null ? '' : ` ${r.age_seconds}s`)

function explicitVerdict(r: LeastUsedReading, ceilingPct: number): { refusal?: string; warning?: string } {
  if (r.state === 'auth_fail') return { refusal: `${r.account}'s login failed` }
  if (r.state === 'over_ceiling' || r.state === 'five_hour_full')
    return { refusal: `${r.account} is at or over the ${ceilingPct}% ceiling` }
  if (r.state === 'refused') return { refusal: `${r.account} is refused by the spawn's gates` }
  if (r.state === 'stale') return { warning: `${r.account}'s reading is stale${ageText(r)}` }
  if (r.state === 'none') return { warning: `${r.account} has no reading` }
  return {}
}

function pickExplicit(
  explicit: string,
  usages: readonly AccountUsage[],
  config: RotationConfig,
  refuses: (dir: string) => boolean,
): LeastUsedPick {
  const readings = usages.map(usage => leastUsedReading(usage, config))
  const target = usages.find(
    u => u.account === explicit || (path.isAbsolute(explicit) && sameDir(u.config_dir, explicit)),
  )
  if (target === undefined) {
    const known = usages.map(u => u.account).join(', ')
    return {
      ok: false,
      reason: `unknown account ${explicit}; known: ${known}`,
      record: { mode: 'explicit', readings },
    }
  }
  const reading = gated(leastUsedReading(target, { ...config, exclude: [] }), refuses)
  const { refusal, warning } = explicitVerdict(reading, config.ceilingPct)
  const record: LeastUsedRecord = {
    mode: 'explicit',
    readings: readings.map(r => (r.config_dir === target.config_dir ? reading : r)),
  }
  if (refusal !== undefined) return { ok: false, reason: `${refusal} (${recordBody(record)})`, record }
  const chosen = { ...record, chosen: target.account, ...(warning === undefined ? {} : { warning }) }
  return { ok: true, dir: target.config_dir, record: chosen }
}

/** The lowest fresh max(five_hour, seven_day) wins; a tie goes to `preferDir`, then to `usages` order. */
export function pickLeastUsed(
  usages: readonly AccountUsage[],
  config: RotationConfig,
  options: LeastUsedOptions = {},
): LeastUsedPick {
  const refuses = options.refuses ?? (() => false)
  if (options.explicit !== undefined) return pickExplicit(options.explicit, usages, config, refuses)
  const readings = usages.map(usage => gated(leastUsedReading(usage, config), refuses))
  const lowest = lowestOf(
    readings.filter(r => r.state === 'fresh'),
    options.preferDir,
  )
  const record: LeastUsedRecord = { mode: 'least-used', readings }
  if (lowest === undefined) {
    return {
      ok: false,
      reason: `no account has a fresh reading under the ${config.ceilingPct}% ceiling (${recordBody(record)})`,
      record,
    }
  }
  return { ok: true, dir: lowest.config_dir, record: { ...record, chosen: lowest.account } }
}

const windowsText = (r: LeastUsedReading): string => {
  const pctOf = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v)}`)
  return `[5h ${pctOf(r.five_hour)} 7d ${pctOf(r.seven_day)}]`
}

const LEAST_USED_LABEL: Partial<Record<ReadingState, string>> = {
  fresh: '',
  over_ceiling: ' over ceiling',
  five_hour_full: ' over ceiling',
  refused: ' refused',
}

function leastUsedReadingText(r: LeastUsedReading): string {
  const label = LEAST_USED_LABEL[r.state]
  if (label !== undefined) return `${r.account}${label} ${Math.round(score(r))}% ${windowsText(r)}`
  if (r.state === 'stale') return `${r.account} stale${ageText(r)}`
  if (r.state === 'auth_fail') return `${r.account} login failed`
  return `${r.account} ${r.state === 'none' ? 'no reading' : r.state}`
}

const recordBody = (record: LeastUsedRecord): string => {
  const warning = record.warning === undefined ? '' : `; warning: ${record.warning}`
  return `${record.mode}; max(5h,7d): ${record.readings.map(leastUsedReadingText).join(', ')}${warning}`
}

/** The choice and every reading, e.g. `agents (least-used; max(5h,7d): default 72% [5h 72 7d 40], ...)`. */
export function leastUsedText(record: LeastUsedRecord): string {
  return `${record.chosen ?? 'none'} (${recordBody(record)})`
}
