import fs from 'node:fs'
import path from 'node:path'
import { backoffDelay, classifyFailure, parseRetryAfter } from './policy.js'

export interface GhResult {
  code: number
  stdout: string
  stderr: string
}

export interface ThrottleDeps {
  now(): number
  sleep(ms: number): Promise<void>
  runGh(args: string[]): Promise<GhResult>
  /** Core REST quota left, or undefined when it could not be read. */
  coreRemaining(): Promise<number | undefined>
  notice(line: string): void
  lockDir: string
  stampPath: string
  gapMs: number
}

const LOCK_POLL_MS = 100
/** Longer than the largest backoff plus a slow gh call; an owner holding it this long has hung. */
const STALE_LOCK_MS = 10 * 60_000
const OWNERLESS_GRACE_MS = 10_000

/**
 * Runs one gh write under the machine-wide lock, spaced from the previous one,
 * retrying the secondary rate limit. Returns the final attempt's result as gh gave it.
 */
export async function ghWrite(args: string[], deps: ThrottleDeps): Promise<GhResult> {
  for (let attempt = 0; ; attempt++) {
    const { result, retryInMs } = await withLock(deps, () => spacedAttempt(args, attempt, deps))
    if (retryInMs === undefined) return result
    deps.notice(
      `gh-write: GitHub secondary rate limit; retrying in ${Math.round(retryInMs / 1000)}s (retry ${attempt + 1})`,
    )
  }
}

async function spacedAttempt(args: string[], attempt: number, deps: ThrottleDeps) {
  const wait = readNotBefore(deps.stampPath) - deps.now()
  if (wait > 0) await deps.sleep(wait)
  const result = await deps.runGh(args)
  const retryInMs = await retryDelay(result, attempt, deps)
  writeNotBefore(deps.stampPath, deps.now() + Math.max(deps.gapMs, retryInMs ?? 0))
  return { result, retryInMs }
}

async function retryDelay(
  result: GhResult,
  attempt: number,
  deps: ThrottleDeps,
): Promise<number | undefined> {
  if (result.code === 0) return undefined
  const output = `${result.stdout}\n${result.stderr}`
  const kind = classifyFailure(output)
  if (kind === 'other') return undefined
  if (kind === 'ambiguous' && (await deps.coreRemaining()) === 0) return undefined
  return backoffDelay(attempt, parseRetryAfter(output))
}

function readNotBefore(stampPath: string): number {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
    const value = (parsed as { notBefore?: unknown }).notBefore
    return typeof value === 'number' ? value : 0
  } catch {
    return 0
  }
}

function writeNotBefore(stampPath: string, notBefore: number): void {
  fs.writeFileSync(stampPath, JSON.stringify({ notBefore }))
}

async function withLock<T>(deps: ThrottleDeps, body: () => Promise<T>): Promise<T> {
  await acquire(deps)
  try {
    return await body()
  } finally {
    fs.rmSync(deps.lockDir, { recursive: true, force: true })
  }
}

/** `mkdir` is atomic, so whoever creates the directory owns the lock. */
async function acquire(deps: ThrottleDeps): Promise<void> {
  fs.mkdirSync(path.dirname(deps.lockDir), { recursive: true })
  for (;;) {
    try {
      fs.mkdirSync(deps.lockDir)
      fs.writeFileSync(path.join(deps.lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: deps.now() }))
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    if (isStale(deps)) fs.rmSync(deps.lockDir, { recursive: true, force: true })
    else await deps.sleep(LOCK_POLL_MS)
  }
}

function isStale(deps: ThrottleDeps): boolean {
  let owner: { pid?: unknown; at?: unknown }
  try {
    owner = JSON.parse(fs.readFileSync(path.join(deps.lockDir, 'owner'), 'utf8')) as typeof owner
  } catch {
    // The owner file lands just after the mkdir; missing for long means that owner died in between.
    return ownerlessFor(deps.lockDir) > OWNERLESS_GRACE_MS
  }
  if (typeof owner.at === 'number' && deps.now() - owner.at > STALE_LOCK_MS) return true
  return typeof owner.pid === 'number' && !isAlive(owner.pid)
}

function ownerlessFor(lockDir: string): number {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs
  } catch {
    return 0
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
