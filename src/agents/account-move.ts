import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAccountUsage, type AccountUsage } from './account-budget.js'
import { accountIdentity, explicitDirIdentity } from './account-identity.js'
import { SESSION_ID_SHAPE } from './budget.js'
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

/** A locked or prompting Keychain must not hang the check; a lookup this slow reads as no login. */
export const LOGIN_LOOKUP_TIMEOUT_MS = 5_000

export interface LoginProbe {
  platform?: NodeJS.Platform
  exec?: (file: string, args: string[], options: { stdio: 'ignore'; timeout: number }) => unknown
}

/**
 * Whether the target holds a login, by Keychain item presence on macOS or credentials file presence
 * elsewhere. `find-generic-password` without `-g` or `-w` prints attributes only, not the secret.
 */
export function hasLogin(target: AccountTarget, probe: LoginProbe = {}): boolean {
  if ((probe.platform ?? process.platform) !== 'darwin')
    return fs.existsSync(path.join(target.dir, '.credentials.json'))
  const exec = probe.exec ?? execFileSync
  try {
    exec('security', ['find-generic-password', '-s', keychainService(target)], {
      stdio: 'ignore',
      timeout: LOGIN_LOOKUP_TIMEOUT_MS,
    })
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
  identity: target =>
    target.unset === true ? accountIdentity(target.dir, home) : explicitDirIdentity(target.dir),
  usage: target => readAccountUsage(target.dir, { home }),
  hasLogin: target => hasLogin(target),
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
  if (!readers.hasLogin(to)) refusals.push(`${to.dir} holds no login (${keychainService(to)})`)
  else if (usage.auth_fail) refusals.push(`${to.dir}'s login is refused, or expired with no refresh token`)
  return refusals
}

function usageRefusals(input: AccountCheckInput, usage: AccountUsage): string[] {
  if (usage.source === null) return [`${usage.config_dir} has no usage reading`]
  if (usage.stale) return [`${usage.config_dir}'s usage reading is stale (${usage.age_seconds}s old)`]
  const absent = (['five_hour', 'seven_day'] as const).filter(name => usage[name] === null)
  if (absent.length > 0) return absent.map(name => `${usage.config_dir} has no ${name} reading`)
  if (input.force === true) return []
  const fiveCeiling = input.limits?.fiveHour ?? ACCOUNT_HARD_LIMIT
  const sevenLine = input.limits?.sevenDay ?? ACCOUNT_HARD_LIMIT
  const five = usage.five_hour?.used_pct
  const seven = usage.seven_day?.used_pct
  const refusals: string[] = []
  if (five !== undefined && five >= fiveCeiling)
    refusals.push(`five_hour ${five}% is at or over the ceiling of ${fiveCeiling}%`)
  if (seven !== undefined && seven >= sevenLine)
    refusals.push(`seven_day ${seven}% is at or over its line of ${sevenLine}%`)
  return refusals
}

/** A move runs headless, where a trust prompt has nobody to answer, so only a definite yes passes. */
function trustRefusal(input: AccountCheckInput): string | undefined {
  const configDir = childConfigDir(input.to)
  const trusted = input.readers.trusted(input.cwd, configDir)
  if (trusted === true) return undefined
  const config = configDir ?? 'the default config'
  return trusted === false
    ? `${config} has no accepted trust entry for ${input.cwd}`
    : `${config}'s trust entries cannot be read, so ${input.cwd} is not known to be trusted`
}

/** Every reason the session may not move to `to`; empty means it may. */
export function accountTargetCheck(input: AccountCheckInput): AccountCheck {
  const usage = input.readers.usage(input.to)
  const refusals = [...loginRefusals(input, usage), ...usageRefusals(input, usage)]
  const trust = trustRefusal(input)
  if (trust !== undefined) refusals.push(trust)
  return { ok: refusals.length === 0, refusals }
}

export interface TranscriptMove {
  from: AccountTarget
  to: AccountTarget
  cwd: string
  sessionId: string
  now?: number
  /** Renames the source aside. Injected so a test can fail it after the target is written. */
  rename?: (from: string, to: string) => void
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
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

interface Snapshot {
  bytes: Buffer
  mtime: Date
}

const snapshot = (file: string): Snapshot | undefined =>
  fs.existsSync(file) ? { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtime } : undefined

/** Put back a file's bytes and its mtime, which the "newer at the target" refusal compares. */
function restore(file: string, previous: Snapshot | undefined): void {
  if (previous === undefined) return fs.rmSync(file, { force: true })
  writeAtomic(file, previous.bytes)
  fs.utimesSync(file, previous.mtime, previous.mtime)
}

/**
 * Copy `source` over `target`, then rename `source` aside. When the rename fails, the target goes back
 * to what it held before, so only one resumable copy exists and a retry is not refused as "newer".
 */
function copyThenRetire(
  source: string,
  target: string,
  movedSource: string,
  rename: TranscriptMove['rename'],
) {
  const bytes = fs.readFileSync(source)
  const previous = snapshot(target)
  writeAtomic(target, bytes)
  try {
    ;(rename ?? fs.renameSync)(source, movedSource)
  } catch (err) {
    rollBack(target, previous, err as Error)
    throw err
  }
  return bytes.length
}

/** A failed rollback is reported beside the rename's error, never in place of it. */
function rollBack(target: string, previous: Snapshot | undefined, cause: Error): void {
  try {
    restore(target, previous)
  } catch (err) {
    throw new Error(`${cause.message}; rolling back ${target} also failed: ${(err as Error).message}`)
  }
}

/** Why the transcript cannot move, so the broker can refuse before it ends anything; undefined when it can. */
export function transcriptMoveBlocker(move: TranscriptMove): string | undefined {
  if (!SESSION_ID_SHAPE.test(move.sessionId)) return `unusable session id: ${JSON.stringify(move.sessionId)}`
  const source = transcriptPath(move.cwd, move.sessionId, move.from.dir)
  const target = transcriptPath(move.cwd, move.sessionId, move.to.dir)
  // Unset and an explicit ~/.claude are two logins over one dir: a copy onto itself, then a rename, loses it.
  if (path.resolve(source) === path.resolve(target))
    return `${move.from.dir} and ${move.to.dir} hold the same transcript file, so it cannot move between them`
  const sourceTime = mtimeOf(source)
  if (sourceTime === undefined) return `no transcript at ${source}`
  const targetTime = mtimeOf(target)
  if (targetTime !== undefined && targetTime > sourceTime)
    return `${target} is newer than ${source}; the session already ran on the target`
  return undefined
}

/**
 * Copy the session's transcript to the target account and rename the source to `.moved-<time>`,
 * keeping its bytes, so nothing resumes the old copy and splits the session (CC-959). A target copy
 * newer than the source is refused: it means the session already ran there. The session id becomes
 * a path segment, so it must have the shape a session id has.
 */
export function moveTranscript(move: TranscriptMove): TranscriptMoveResult {
  const error = transcriptMoveBlocker(move)
  if (error !== undefined) return { ok: false, error }
  const source = transcriptPath(move.cwd, move.sessionId, move.from.dir)
  const target = transcriptPath(move.cwd, move.sessionId, move.to.dir)
  const stamp = new Date(move.now ?? Date.now()).toISOString().replace(/[:.]/g, '-')
  const movedSource = `${source}.moved-${stamp}`
  try {
    const bytes = copyThenRetire(source, target, movedSource, move.rename)
    return { ok: true, transcript: target, movedSource, bytes }
  } catch (err) {
    return { ok: false, error: `transcript move failed: ${(err as Error).message}` }
  }
}
