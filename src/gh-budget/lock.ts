import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A machine-wide mutex held as a directory: `mkdir` is atomic, so whoever creates it owns the lock.
 * Shared by gh-write's write spacing and the gh-budget cooldown state (CC-1162).
 */

export interface LockDeps {
  now(): number
  sleep(ms: number): Promise<void>
  lockDir: string
}

const LOCK_POLL_MS = 100
/** The lock is held for one short critical section only, so an owner holding it this long has hung. */
const STALE_LOCK_MS = 10 * 60_000
const OWNERLESS_GRACE_MS = 10_000
const TOKEN_FILE = 'owner'

interface Token {
  pid: number
  nonce: string
  at: number
}

export async function withLock<T>(deps: LockDeps, body: () => Promise<T>): Promise<T> {
  const nonce = await acquire(deps)
  try {
    return await body()
  } finally {
    release(deps.lockDir, nonce)
  }
}

async function acquire(deps: LockDeps): Promise<string> {
  fs.mkdirSync(path.dirname(deps.lockDir), { recursive: true })
  for (;;) {
    const nonce = tryCreate(deps)
    if (nonce !== undefined) return nonce
    const stale = staleToken(deps)
    if (stale === undefined || !takeOver(deps.lockDir, stale)) await deps.sleep(LOCK_POLL_MS)
  }
}

function tryCreate(deps: LockDeps): string | undefined {
  try {
    fs.mkdirSync(deps.lockDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw err
  }
  const token: Token = { pid: process.pid, nonce: randomUUID(), at: deps.now() }
  fs.writeFileSync(path.join(deps.lockDir, TOKEN_FILE), JSON.stringify(token))
  return token.nonce
}

/** Removes the lock only while it is still ours; after a takeover it belongs to someone else. */
function release(lockDir: string, nonce: string): void {
  if (readToken(lockDir)?.nonce !== nonce) return
  removeQuietly(lockDir)
}

/** The raw token text of a lock that may be taken over, '' for one with no token, else undefined. */
function staleToken(deps: LockDeps): string | undefined {
  const raw = readRaw(deps.lockDir)
  const token = raw === undefined ? undefined : parseToken(raw)
  // A token mid-write reads as missing or truncated; only a long-ownerless lock is stale.
  if (token === undefined) return ownerlessFor(deps.lockDir) > OWNERLESS_GRACE_MS ? (raw ?? '') : undefined
  const expired = deps.now() - token.at > STALE_LOCK_MS
  return expired || !isAlive(token.pid) ? raw : undefined
}

/**
 * Renames the stale lock aside, then deletes it. Only one contender's rename
 * can succeed; the losers see ENOENT and go back to acquiring.
 */
function takeOver(lockDir: string, seen: string): boolean {
  if ((readRaw(lockDir) ?? '') !== seen) return false
  const aside = `${lockDir}.stale.${randomUUID()}`
  try {
    fs.renameSync(lockDir, aside)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return false
    throw err
  }
  removeQuietly(aside)
  return true
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    // A leftover directory costs nothing; failing the caller over it would.
  }
}

function readRaw(lockDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(lockDir, TOKEN_FILE), 'utf8')
  } catch {
    return undefined
  }
}

function readToken(lockDir: string): Token | undefined {
  const raw = readRaw(lockDir)
  return raw === undefined ? undefined : parseToken(raw)
}

function parseToken(raw: string): Token | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<Token>
    const valid =
      typeof parsed.pid === 'number' && typeof parsed.nonce === 'string' && typeof parsed.at === 'number'
    return valid ? (parsed as Token) : undefined
  } catch {
    return undefined
  }
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
