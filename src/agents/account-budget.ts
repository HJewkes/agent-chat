import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readAccountBudget,
  readStatusLineBudget,
  STALE_AFTER_SECONDS,
  type BudgetRead,
  type BudgetWindow,
} from './budget.js'
import { accountName, defaultConfigDir, profileRoot } from './config-dir.js'

/**
 * One row per Claude account on this machine (CC-891): both rate-limit windows,
 * where they came from and how old they are. The usage poller (item 94) writes
 * `usage-poller.json` into each account's status cache from the OAuth usage
 * endpoint every two minutes, so it is the reading of record; the freshest
 * status-line reading stands in where the poller has not written. Nothing here
 * calls the API.
 */

export const POLLER_SESSION = 'usage-poller'

/** Two missed polls plus slack: the poller runs every 120s, so an older reading means it stopped. */
export const POLLER_STALE_AFTER_SECONDS = 300

/** The poller's log names each account by its config dir's basename; these kinds mean it holds no login. */
const AUTH_FAILURES = new Set(['AUTH-FAIL', 'AUTH-EXPIRED', 'TOKEN-EXPIRED'])

export type UsageSource = 'usage-poller' | 'status-line'

export interface AccountUsage {
  account: string
  config_dir: string
  source: UsageSource | null
  five_hour: BudgetWindow | null
  seven_day: BudgetWindow | null
  age_seconds: number | null
  stale: boolean
  auth_fail: boolean
}

export interface AccountsOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  now?: number
  pollerLog?: string
}

export const defaultPollerLog = (home: string): string =>
  path.join(home, '.local', 'state', 'usage-poller', 'poller.log')

/** `~/.claude` first, then every profile dir, in name order. */
export function accountDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const root = profileRoot(env, home)
  let profiles: string[] = []
  try {
    profiles = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name))
      .sort()
  } catch {
    profiles = []
  }
  return [defaultConfigDir(home), ...profiles]
}

/** The basenames whose latest poller log line is an auth failure. An absent log is no failures. */
export function authFailures(logFile: string): Set<string> {
  let text: string
  try {
    text = fs.readFileSync(logFile, 'utf8')
  } catch {
    return new Set()
  }
  const latest = new Map<string, string>()
  for (const line of text.split('\n')) {
    const [, kind, name] = line.split(' ')
    if (kind !== undefined && name !== undefined) latest.set(name.replace(/:$/, ''), kind)
  }
  return new Set([...latest].filter(([, kind]) => AUTH_FAILURES.has(kind)).map(([name]) => name))
}

function pickReading(
  dir: string,
  now: number,
): { read: BudgetRead; source: UsageSource; staleAfter: number } {
  const poller = readStatusLineBudget(POLLER_SESSION, now, dir)
  if (poller.found) return { read: poller, source: 'usage-poller', staleAfter: POLLER_STALE_AFTER_SECONDS }
  return { read: readAccountBudget(dir, now), source: 'status-line', staleAfter: STALE_AFTER_SECONDS }
}

export function readAccountUsage(
  dir: string,
  options: AccountsOptions = {},
  failures: Set<string> = authFailures(options.pollerLog ?? defaultPollerLog(options.home ?? os.homedir())),
): AccountUsage {
  const home = options.home ?? os.homedir()
  const { read, source, staleAfter } = pickReading(dir, options.now ?? Date.now())
  const base = {
    account: accountName(dir, home),
    config_dir: dir,
    auth_fail: failures.has(path.basename(dir)),
  }
  if (!read.found) {
    return { ...base, source: null, five_hour: null, seven_day: null, age_seconds: null, stale: false }
  }
  const { rate_limits } = read.budget
  return {
    ...base,
    source,
    five_hour: rate_limits.five_hour ?? null,
    seven_day: rate_limits.seven_day ?? null,
    age_seconds: read.age_seconds,
    stale: read.age_seconds > staleAfter,
  }
}

const isoReset = (resetsAt: number | undefined): string =>
  resetsAt === undefined ? 'reset unknown' : `resets ${new Date(resetsAt * 1000).toISOString()}`

const windowText = (name: string, w: BudgetWindow | null): string =>
  w === null ? `${name} n/a` : `${name} ${Math.round(w.used_pct)}% (${isoReset(w.resets_at)})`

export function formatAccountUsage(usage: AccountUsage, width: number): string {
  const flags = [usage.stale ? 'STALE' : '', usage.auth_fail ? 'AUTH-FAIL' : ''].filter(f => f !== '')
  const marks = flags.length > 0 ? ` ${flags.join(' ')}` : ''
  const name = usage.account.padEnd(width)
  if (usage.source === null) return `${name}  no reading${marks}`
  const windows = `${windowText('five_hour', usage.five_hour)}  ${windowText('seven_day', usage.seven_day)}`
  return `${name}  ${windows}  ${usage.age_seconds}s old via ${usage.source}${marks}`
}

/** The `agent budget --accounts` report: one line per account, or one JSON array of the same rows. */
export function accountsBudget(json: boolean, options: AccountsOptions = {}) {
  const home = options.home ?? os.homedir()
  const failures = authFailures(options.pollerLog ?? defaultPollerLog(home))
  const rows = accountDirs(home, options.env ?? process.env).map(dir =>
    readAccountUsage(dir, { ...options, home }, failures),
  )
  if (json) return { ok: true, lines: [JSON.stringify(rows)] }
  const width = Math.max(...rows.map(r => r.account.length))
  return { ok: true, lines: rows.map(row => formatAccountUsage(row, width)) }
}
