import fs from 'node:fs'
import path from 'node:path'
import { home } from '../../paths.js'

/**
 * One watchdog run at a time (CC-326): two overlapping runs would each resume the
 * same dark seat. A run that finds the lock held does nothing.
 */

/** Longer than any run: every broker request a run makes times out within a minute. */
export const LOCK_STALE_MS = 30 * 60_000

export const watchdogLockPath = (): string => path.join(home(), 'seat-watchdog.lock')

export type RunLock = { held: true; release: () => void; note?: string } | { held: false; reason: string }

export interface LockOptions {
  pid?: number
  now?: () => number
  alive?: (pid: number) => boolean
}

interface Holder {
  raw: string
  pid: number | undefined
  at: number
}

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code

/** A pid that exists but is another user's answers EPERM, which still means alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) === 'EPERM'
  }
}

/** Linked into place with its content, so a reader never sees a lock that names no holder. */
function create(file: string, pid: number, at: number): boolean {
  const tmp = `${file}.${pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ pid, at }))
  try {
    fs.linkSync(tmp, file)
    return true
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false
    throw err
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Undefined when the lock went away after the create that found it. */
function readHolder(file: string): Holder | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const written = fs.statSync(file).mtimeMs
    try {
      const doc = JSON.parse(raw) as { pid?: unknown; at?: unknown }
      return { raw, pid: asNumber(doc.pid), at: asNumber(doc.at) ?? written }
    } catch {
      return { raw, pid: undefined, at: written }
    }
  } catch {
    return undefined
  }
}

/** A lock is stale when its run is gone, or it is older than any run can be. */
function staleReason(holder: Holder, now: number, alive: (pid: number) => boolean): string | undefined {
  if (holder.pid !== undefined && !alive(holder.pid)) return `its run (pid ${holder.pid}) is gone`
  if (now - holder.at > LOCK_STALE_MS) return `it is over ${LOCK_STALE_MS / 60_000} min old`
  return undefined
}

/** Moves the stale lock aside. False when another run moved it first, or what it moved was a fresh lock. */
function clearStale(file: string, stale: Holder, pid: number): boolean {
  const aside = `${file}.stale.${pid}`
  try {
    fs.renameSync(file, aside)
  } catch {
    return false
  }
  const same = fs.readFileSync(aside, 'utf8') === stale.raw
  try {
    if (!same) fs.linkSync(aside, file)
  } finally {
    fs.rmSync(aside, { force: true })
  }
  return same
}

const hhmmZ = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`

export function acquireRunLock(file = watchdogLockPath(), options: LockOptions = {}): RunLock {
  const pid = options.pid ?? process.pid
  const now = (options.now ?? Date.now)()
  const release = (): void => {
    if (readHolder(file)?.pid === pid) fs.rmSync(file, { force: true })
  }
  if (create(file, pid, now)) return { held: true, release }
  const holder = readHolder(file)
  if (holder === undefined) return { held: false, reason: 'another run released the lock just now' }
  const stale = staleReason(holder, now, options.alive ?? pidAlive)
  if (stale === undefined) {
    const who = `pid ${holder.pid ?? 'unknown'}, since ${hhmmZ(holder.at)}`
    return { held: false, reason: `another run holds ${path.basename(file)} (${who})` }
  }
  if (!clearStale(file, holder, pid) || !create(file, pid, now))
    return { held: false, reason: 'another run took over a stale lock first' }
  return { held: true, release, note: `took over a stale run lock: ${stale}` }
}
