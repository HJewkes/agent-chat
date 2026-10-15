import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { POLL_SESSION_ID, type LoginState } from '@titan-design/anthropic-account'
import { readLoginState } from '@titan-design/anthropic-account/node'
import {
  readAccountBudget,
  readStatusLineBudget,
  STALE_AFTER_SECONDS,
  type BudgetRead,
  type BudgetWindow,
} from './budget.js'
import { accountIdentity } from './account-identity.js'
import { accountName, defaultConfigDir, profileRoot } from './config-dir.js'

/**
 * One row per Claude account on this machine (CC-891): both rate-limit windows,
 * where they came from and how old they are. The usage poller
 * (`anthropic-account poll --write`, on `anthropic-account-poll.timer`) writes
 * `usage-poll.json` into each account's status cache from the OAuth usage
 * endpoint every 150s, so it is the reading of record; the freshest
 * status-line reading stands in where the poller has not written. `auth_fail` is
 * the dir's own login state, read token-free from its `.credentials.json`; on macOS
 * an absent file means the login is in the Keychain, so only a present file can fail
 * there. Nothing here calls the API.
 */

/** Two missed polls: a 150s interval plus up to 30s jitter, so an older reading means it stopped. */
export const POLLER_STALE_AFTER_SECONDS = 360

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
  platform?: NodeJS.Platform
  /** CC-1289: a config dir's Anthropic login. Absent: read from its `.claude.json` under `home`. */
  identify?: (configDir: string) => string | undefined
}

/** CC-1289: one account's row, naming every config dir that logs in to it. */
export interface AccountRow extends AccountUsage {
  config_dirs: string[]
}

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

/**
 * A login Claude Code cannot use and the poller cannot renew; an expired one that can refresh renews
 * within a tick. On macOS Claude Code keeps the login in the Keychain, so a missing file is not a failure.
 */
export function loginFailed(state: LoginState, platform: NodeJS.Platform = process.platform): boolean {
  if (state.status === 'missing') return platform !== 'darwin'
  return state.status === 'refused' || (state.status === 'expired' && !state.canRefresh)
}

/** A login we cannot read is not one we can use; the thrown error is already redacted and is dropped. */
export function readLoginFailed(dir: string, now: number, platform?: NodeJS.Platform): boolean {
  try {
    return loginFailed(readLoginState(dir, { now }), platform)
  } catch {
    return true
  }
}

function pickReading(
  dir: string,
  now: number,
): { read: BudgetRead; source: UsageSource; staleAfter: number } {
  const poller = readStatusLineBudget(POLL_SESSION_ID, now, dir)
  if (poller.found) return { read: poller, source: 'usage-poller', staleAfter: POLLER_STALE_AFTER_SECONDS }
  return { read: readAccountBudget(dir, now), source: 'status-line', staleAfter: STALE_AFTER_SECONDS }
}

export function readAccountUsage(dir: string, options: AccountsOptions = {}): AccountUsage {
  const home = options.home ?? os.homedir()
  const now = options.now ?? Date.now()
  const { read, source, staleAfter } = pickReading(dir, now)
  const base = {
    account: accountName(dir, home),
    config_dir: dir,
    auth_fail: readLoginFailed(dir, now, options.platform),
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

const fresher = (a: AccountUsage, b: AccountUsage): AccountUsage =>
  b.age_seconds !== null && (a.age_seconds === null || b.age_seconds < a.age_seconds) ? b : a

/**
 * One row per Anthropic login, named by its first config dir and showing the freshest reading
 * among them, since every dir on one login reads the same limits. A dir with no readable login is
 * its own row.
 */
export function groupByAccount(
  rows: readonly AccountUsage[],
  identify: (configDir: string) => string | undefined,
): AccountRow[] {
  const groups = new Map<string, AccountUsage[]>()
  for (const row of rows) {
    const key = identify(row.config_dir) ?? `dir:${row.config_dir}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()].map(members => {
    const head = members[0] as AccountUsage
    return {
      ...members.reduce(fresher),
      account: head.account,
      config_dir: head.config_dir,
      auth_fail: members.some(r => r.auth_fail),
      config_dirs: members.map(r => r.config_dir),
    }
  })
}

/** `default (+personal)`: the account's first config dir, naming the others that log in to it. */
function accountLabel(row: AccountRow, home: string): string {
  const others = row.config_dirs.slice(1).map(dir => `+${accountName(dir, home)}`)
  return others.length === 0 ? row.account : `${row.account} (${others.join(', ')})`
}

/** The `agent budget --accounts` report: one line per account, or one JSON array of the same rows. */
export function accountsBudget(json: boolean, options: AccountsOptions = {}) {
  const home = options.home ?? os.homedir()
  const usages = accountDirs(home, options.env ?? process.env).map(dir =>
    readAccountUsage(dir, { ...options, home }),
  )
  const rows = groupByAccount(usages, options.identify ?? (dir => accountIdentity(dir, home)))
  if (json) return { ok: true, lines: [JSON.stringify(rows)] }
  const named = rows.map(row => ({ ...row, account: accountLabel(row, home) }))
  const width = Math.max(...named.map(r => r.account.length))
  return { ok: true, lines: named.map(row => formatAccountUsage(row, width)) }
}
