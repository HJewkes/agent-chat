import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { restartLockPath } from '../paths.js'
import { isProcessAlive } from './lifecycle.js'

/**
 * TP-4347: while `service restart` holds this lock, only the broker it starts may bind.
 *
 * A session MCP that loses the broker relaunches one within ~100 ms, before the restart's
 * own child is up, and that broker then carries the session's environment and lineage. The
 * restart hands its child a token through `AGENT_CHAT_RESTART_TOKEN`; a broker without it
 * refuses. Not a hold (`hold.ts`): the restart's own `start()` clears holds, and a hold has no owner.
 */

/** The longest lock accepted, so a crashed restart never wedges the bus for long. */
export const MAX_RESTART_LOCK_S = 120

export interface RestartLock {
  token: string
  /** The `service restart` process, not its broker: a dead holder means a crashed restart. */
  pid: number
  /** Epoch ms. */
  until: number
}

/** The live lock, or undefined; an expired, over-cap, malformed or orphaned lock counts as none. */
export function restartLockHolder(now: number = Date.now()): RestartLock | undefined {
  const lock = readLock()
  if (lock === undefined) return undefined
  const live = lock.until > now && lock.until <= now + MAX_RESTART_LOCK_S * 1000 && isProcessAlive(lock.pid)
  return live ? lock : undefined
}

/** Returns the new token, or the live holder when another restart has the lock. */
export function takeRestartLock(
  seconds: number,
  now: number = Date.now(),
): { token: string } | { holder: RestartLock } {
  const lock: RestartLock = {
    token: randomBytes(16).toString('hex'),
    pid: process.pid,
    until: now + Math.min(seconds, MAX_RESTART_LOCK_S) * 1000,
  }
  if (createExclusive(lock)) return { token: lock.token }
  const holder = restartLockHolder(now)
  if (holder !== undefined) return { holder }
  fs.rmSync(restartLockPath(), { force: true })
  if (createExclusive(lock)) return { token: lock.token }
  const winner = restartLockHolder(now)
  if (winner === undefined) throw new Error(`could not take ${restartLockPath()}`)
  return { holder: winner }
}

/** Removes the lock only when `token` still owns it, so a late release never frees a successor's. */
export function releaseRestartLock(token: string): void {
  if (readLock()?.token === token) fs.rmSync(restartLockPath(), { force: true })
}

/** Written in full under a private name and linked into place, so no reader sees half a lock. */
function createExclusive(lock: RestartLock): boolean {
  const staging = `${restartLockPath()}.${process.pid}.${lock.token.slice(0, 8)}`
  fs.writeFileSync(staging, JSON.stringify(lock), { mode: 0o600, flag: 'wx' })
  try {
    fs.linkSync(staging, restartLockPath())
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    fs.rmSync(staging, { force: true })
  }
}

function readLock(): RestartLock | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(restartLockPath(), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { token, pid, until } = parsed as Partial<RestartLock>
  const valid = typeof token === 'string' && token !== '' && Number.isInteger(pid) && Number.isFinite(until)
  return valid ? { token, pid: pid as number, until: until as number } : undefined
}
