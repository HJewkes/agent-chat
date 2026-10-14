import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAccountUsage, type AccountUsage } from './account-budget.js'
import { accountIdentity } from './account-identity.js'
import { checkConfigDir, childConfigDir, defaultConfigDir, profileDir } from './config-dir.js'
import { transcriptPath } from './transcript.js'
import { isTrusted } from './trust.js'

/**
 * CC-892 a: the checks and the transcript copy behind moving a live session to another account.
 * The broker operation (S2) ends the session, calls `moveTranscript`, and resumes the same session
 * id under the target. Every refusal here runs before anything ends.
 *
 * Why `claude` is the default account with `CLAUDE_CONFIG_DIR` unset, never `~/.claude`: with the
 * variable set to `~/.claude`, Claude Code reads `~/.claude/.claude.json` and a Keychain login keyed
 * by a hash of the path, a separate login and trust store from the unset one (CC-200, S0 b).
 */

/** The named profiles a human may move to; any other value must be a config dir path. */
export const PROFILE_ACCOUNTS = ['personal', 'server', 'agents', 'workout'] as const

/** An account's own hard limit, the ceiling when no charter pool names one. */
export const ACCOUNT_HARD_LIMIT = 100

export interface AccountTarget {
  dir: string
  /** The session runs with `CLAUDE_CONFIG_DIR` unset: the default account. */
  unset?: true
}

export interface AccountTargetOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  isDirectory?: (dir: string) => boolean
}

const realIsDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** `claude`, a profile name, or an absolute config dir, as the account a session would bill. */
export function resolveAccountTarget(
  account: string,
  opts: AccountTargetOptions = {},
): AccountTarget | { error: string } {
  const home = opts.home ?? os.homedir()
  const isDirectory = opts.isDirectory ?? realIsDirectory
  if (account === 'claude') return { dir: defaultConfigDir(home), unset: true }
  if ((PROFILE_ACCOUNTS as readonly string[]).includes(account)) {
    const dir = profileDir(account, opts.env ?? process.env, home)
    return isDirectory(dir) ? { dir } : { error: `account ${account} has no config dir at ${dir}` }
  }
  const problem = checkConfigDir(account, { home, isDirectory })
  return problem === undefined ? { dir: path.resolve(account) } : { error: problem }
}

/** The Keychain service Claude Code stores a config dir's login under (S0 b). Names it; never reads it. */
export function keychainService(target: AccountTarget): string {
  const dir = childConfigDir(target)
  if (dir === undefined) return 'Claude Code-credentials'
  return `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`
}

/**
 * Whether the target holds a login, by Keychain item presence on macOS or credentials file presence
 * elsewhere. `find-generic-password` without `-g` or `-w` prints attributes only, not the secret.
 */
export function hasLogin(target: AccountTarget): boolean {
  if (process.platform !== 'darwin') return fs.existsSync(path.join(target.dir, '.credentials.json'))
  try {
    execFileSync('security', ['find-generic-password', '-s', keychainService(target)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Every read the check makes, injected so tests never touch a real login. */
export interface AccountReaders {
  identity: (target: AccountTarget) => string | undefined
  usage: (target: AccountTarget) => AccountUsage
  hasLogin: (target: AccountTarget) => boolean
  trusted: (cwd: string, configDir: string | undefined) => boolean | undefined
}

export const realAccountReaders = (home: string = os.homedir()): AccountReaders => ({
  identity: target => accountIdentity(target.dir, home),
  usage: target => readAccountUsage(target.dir, { home }),
  hasLogin,
  trusted: isTrusted,
})

export interface AccountCheckInput {
  from: AccountTarget
  to: AccountTarget
  cwd: string
  /** The target pool's five_hour ceiling and seven_day line; each defaults to the hard limit. */
  limits?: { fiveHour?: number; sevenDay?: number }
  /** The human lifts the usage refusals, and only those. */
  force?: boolean
  readers: AccountReaders
}

export interface AccountCheck {
  ok: boolean
  refusals: string[]
}

const sameAccount = (a: AccountTarget, b: AccountTarget): boolean =>
  path.resolve(a.dir) === path.resolve(b.dir) && (a.unset === true) === (b.unset === true)

function loginRefusals(input: AccountCheckInput, usage: AccountUsage): string[] {
  const { from, to, readers } = input
  if (sameAccount(from, to)) return [`the session already runs on ${to.dir}`]
  const target = readers.identity(to)
  const refusals: string[] = []
  if (target !== undefined && target === readers.identity(from))
    refusals.push(`${to.dir} bills the same Anthropic login as ${from.dir}, so the move buys no headroom`)
  if (target === undefined) refusals.push(`${to.dir} has no oauthAccount in its .claude.json`)
  if (usage.auth_fail) refusals.push(`the usage poller reports an auth failure for ${to.dir}`)
  if (!readers.hasLogin(to)) refusals.push(`${to.dir} holds no login (${keychainService(to)})`)
  return refusals
}

function usageRefusals(input: AccountCheckInput, usage: AccountUsage): string[] {
  if (usage.source === null) return [`${usage.config_dir} has no usage reading`]
  if (usage.stale) return [`${usage.config_dir}'s usage reading is stale (${usage.age_seconds}s old)`]
  if (input.force === true) return []
  const fiveCeiling = input.limits?.fiveHour ?? ACCOUNT_HARD_LIMIT
  const sevenLine = input.limits?.sevenDay ?? ACCOUNT_HARD_LIMIT
  const refusals: string[] = []
  const five = usage.five_hour?.used_pct
  if (five === undefined) refusals.push(`${usage.config_dir} has no five_hour reading`)
  else if (five >= fiveCeiling)
    refusals.push(`five_hour ${five}% is at or over the ceiling of ${fiveCeiling}%`)
  const seven = usage.seven_day?.used_pct
  if (seven !== undefined && seven >= sevenLine)
    refusals.push(`seven_day ${seven}% is at or over its line of ${sevenLine}%`)
  return refusals
}

/** Every reason the session may not move to `to`; empty means it may. */
export function accountTargetCheck(input: AccountCheckInput): AccountCheck {
  const usage = input.readers.usage(input.to)
  const refusals = [...loginRefusals(input, usage), ...usageRefusals(input, usage)]
  const configDir = childConfigDir(input.to)
  if (input.readers.trusted(input.cwd, configDir) === false)
    refusals.push(`${configDir ?? 'the default config'} has no accepted trust entry for ${input.cwd}`)
  return { ok: refusals.length === 0, refusals }
}

export interface TranscriptMove {
  from: AccountTarget
  to: AccountTarget
  cwd: string
  sessionId: string
  now?: number
}

export type TranscriptMoveResult =
  { ok: true; transcript: string; movedSource: string; bytes: number } | { ok: false; error: string }

const mtimeOf = (file: string): number | undefined => {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

/** Write `bytes` to `file` at mode 0600 through a tmp file and a rename, so a reader never sees half. */
function writeAtomic(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, bytes, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

/**
 * Copy the session's transcript to the target account and rename the source to `.moved-<time>`,
 * keeping its bytes, so nothing resumes the old copy and splits the session (CC-959). A target copy
 * newer than the source is refused: it means the session already ran there.
 */
export function moveTranscript(move: TranscriptMove): TranscriptMoveResult {
  const source = transcriptPath(move.cwd, move.sessionId, move.from.dir)
  const target = transcriptPath(move.cwd, move.sessionId, move.to.dir)
  const sourceTime = mtimeOf(source)
  if (sourceTime === undefined) return { ok: false, error: `no transcript at ${source}` }
  const targetTime = mtimeOf(target)
  if (targetTime !== undefined && targetTime > sourceTime)
    return { ok: false, error: `${target} is newer than ${source}; the session already ran on the target` }
  const stamp = new Date(move.now ?? Date.now()).toISOString().replace(/[:.]/g, '-')
  const movedSource = `${source}.moved-${stamp}`
  try {
    const bytes = fs.readFileSync(source)
    writeAtomic(target, bytes)
    fs.renameSync(source, movedSource)
    return { ok: true, transcript: target, movedSource, bytes: bytes.length }
  } catch (err) {
    return { ok: false, error: `transcript move failed: ${(err as Error).message}` }
  }
}
