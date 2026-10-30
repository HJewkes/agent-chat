import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalPath } from '../../agents/spawn-cwd.js'

/**
 * The per-run temp root global-setup.ts makes (CC-900), and the sweep that removes roots a killed
 * run left behind (CC-1673). A run killed with SIGKILL never reaches its teardown, so the next run
 * removes every root whose owner pid is dead.
 */

export const RUN_PREFIX = 'agent-chat-test-run-'
export const LEGACY_BASE = '/tmp'
const OWNER_FILE = 'owner-pid'
/** A spec's unix socket sits a few dirs below the root, and darwin caps its path at 104 bytes. */
const MAX_BASE_LENGTH = 32
/** A root from before owner files has no pid to check, so only age marks it dead. */
const UNOWNED_STALE_MS = 24 * 60 * 60 * 1000

/**
 * True when `dir` or an ancestor holds a `.git` of any kind. Specs treat a temp dir as outside any
 * repository, and the repo probes walk up, so even an empty stray `/tmp/.git` breaks them (CC-1682).
 */
export function hasGitAbove(dir: string): boolean {
  const real = canonicalPath(dir)
  const parent = path.dirname(real)
  return fs.existsSync(path.join(real, '.git')) || (parent !== real && hasGitAbove(parent))
}

/** `$TMPDIR` when it is short enough for socket paths and outside any checkout, else a short dir on disk. */
export function runBase(tmpdir = os.tmpdir(), home = os.homedir(), inCheckout = hasGitAbove): string {
  const candidates = [tmpdir, path.join(home, '.cache', 'ac-test'), LEGACY_BASE]
  const short = candidates.filter(dir => dir.length <= MAX_BASE_LENGTH)
  return short.find(dir => !inCheckout(dir)) ?? short[0] ?? tmpdir
}

export function createRunRoot(base: string, ownerPid = process.pid): string {
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, RUN_PREFIX))
  // Rename, not write in place: a concurrent sweep must never read the file empty mid-write.
  const pending = path.join(root, `${OWNER_FILE}.tmp`)
  fs.writeFileSync(pending, String(ownerPid))
  fs.renameSync(pending, path.join(root, OWNER_FILE))
  return root
}

/** Removes the run roots in each base whose owner is gone, and returns them. */
export function sweepDeadRuns(bases: readonly string[], now = Date.now()): string[] {
  const swept: string[] = []
  for (const base of new Set(bases)) {
    for (const name of entries(base)) {
      const root = path.join(base, name)
      if (!name.startsWith(RUN_PREFIX) || !isDead(root, now)) continue
      if (removeRunRoot(root)) swept.push(root)
    }
  }
  return swept
}

/**
 * Frees any reader still blocked on a FIFO under the root, then deletes it. False when it could not,
 * or when the root is not a real directory of ours (a symlink must never lead the sweep elsewhere).
 */
export function removeRunRoot(root: string): boolean {
  try {
    if (!isOwnDirectory(root)) return false
    releaseFifos(root)
    fs.rmSync(root, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * A git reading a FIFO include blocks in open() until a writer arrives, and outlives the run that
 * started it. Opening each FIFO for write lets that reader see an empty file and exit.
 */
export function releaseFifos(dir: string): void {
  for (const entry of direntsOf(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) releaseFifos(full)
    else if (entry.isFIFO()) openAndClose(full)
  }
}

function openAndClose(fifo: string): void {
  try {
    fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK))
  } catch {
    // ENXIO: nobody is reading it.
  }
}

function isOwnDirectory(root: string): boolean {
  const stat = fs.lstatSync(root)
  return stat.isDirectory() && stat.uid === process.getuid?.()
}

function isDead(root: string, now: number): boolean {
  try {
    const owner = Number(fs.readFileSync(path.join(root, OWNER_FILE), 'utf8'))
    // An empty or garbage pid says nothing about the owner, so age decides, as with no file.
    if (!Number.isInteger(owner) || owner <= 0) return isStale(root, now)
    return !isAlive(owner)
  } catch {
    return isStale(root, now)
  }
}

function isStale(root: string, now: number): boolean {
  const stat = fs.statSync(root, { throwIfNoEntry: false })
  return stat !== undefined && now - stat.mtimeMs > UNOWNED_STALE_MS
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const entries = (dir: string): string[] => direntsOf(dir).map(entry => entry.name)

function direntsOf(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
