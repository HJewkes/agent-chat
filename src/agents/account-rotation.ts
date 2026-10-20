import path from 'node:path'
import type { AccountUsage } from './account-budget.js'
import { accountName } from './config-dir.js'

/**
 * CC-1546: a worker spawn with no explicit `config_dir` bills the account with the most
 * seven_day headroom. Only a fresh reading can win: a stale or missing one says nothing
 * about the account now, so it never outranks a fresh one, and with no fresh reading at
 * all the spawn keeps the account CC-100 resolved. A tie keeps it too, so rotation moves
 * a spawn only for a strictly lower reading.
 */

export interface RotationConfig {
  enabled: boolean
  /** An account at or above this seven_day used_pct is never rotated to. */
  ceilingPct: number
  /** Account names (`default` for `~/.claude`) or absolute config dirs never rotated to. */
  exclude: readonly string[]
}

export const DEFAULT_ROTATION: RotationConfig = { enabled: true, ceilingPct: 90, exclude: [] }

export type ReadingState = 'fresh' | 'stale' | 'none' | 'excluded' | 'auth_fail' | 'over_ceiling'

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
  return usage.seven_day.used_pct >= config.ceilingPct ? 'over_ceiling' : 'fresh'
}

export const readingOf = (usage: AccountUsage, config: RotationConfig): RotationReading => ({
  account: usage.account,
  config_dir: usage.config_dir,
  used_pct: usage.seven_day?.used_pct ?? null,
  state: stateOf(usage, config),
})

/** The lowest fresh reading wins; the resolved account keeps the spawn unless another is strictly lower. */
export function pickAccount(
  resolvedDir: string,
  usages: readonly AccountUsage[],
  config: RotationConfig,
): RotationPick {
  const readings = usages.map(usage => readingOf(usage, config))
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

const readingText = (r: RotationReading): string =>
  r.state === 'fresh' || r.state === 'over_ceiling'
    ? `${r.account} ${Math.round(r.used_pct ?? 0)}%${r.state === 'over_ceiling' ? ' over ceiling' : ''}`
    : `${r.account} ${r.state === 'none' ? 'no reading' : r.state.replace('_', ' ')}`

/** The spawn result's account line, e.g. `agents (rotated from default; seven_day default 72%, agents 31%)`. */
export function rotationText(record: RotationRecord): string {
  const verdict = record.rotated ? `rotated from ${record.from}` : 'kept'
  return `${record.chosen} (${verdict}; seven_day ${record.readings.map(readingText).join(', ')})`
}
