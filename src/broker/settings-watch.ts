import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { Mismatch } from '../leak-guard/integrity/record.js'
import type { IntegrityLedger } from './integrity-ledger.js'

/**
 * TP-4256 A5: the hook cannot report its own removal, so the broker keeps the sha256 of every launch
 * file it wrote and re-hashes them on every integrity check and on a timer. The first changed or
 * deleted file latches the launch's quarantine through the ledger. Nothing is restored and the agent
 * is not stopped.
 */

export const SETTINGS_WATCH_INTERVAL_MS = 60_000

type Identity = { dev: number; ino: number; size: number }
type Baseline = Identity & { file: string; sha256: string }

// Room to notice a file that grew; the read never takes more than this past the baseline size.
const READ_MARGIN = 4096
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0)

type Inode = Pick<Identity, 'dev' | 'ino'>
const sameFile = (a: Inode, b: Inode): boolean => a.dev === b.dev && a.ino === b.ino

/** Up to `limit` bytes of the regular file `identity` names, or undefined if `fd` is anything else. */
function boundedRead(fd: number, identity: Inode, limit: number): Buffer | undefined {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || !sameFile(identity, stat)) return undefined
  const buffer = Buffer.alloc(limit)
  let length = 0
  while (length < limit) {
    const read = fs.readSync(fd, buffer, length, limit - length, null)
    if (read === 0) break
    length += read
  }
  return buffer.subarray(0, length)
}

/**
 * The one observation of a launch file: lstat first, so a FIFO, device or symlink is never opened,
 * then a non-blocking, no-follow, bounded read of the same regular file. Undefined is a state change.
 */
function observe(file: string, limit: (size: number) => number): Baseline | undefined {
  let fd: number | undefined
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return undefined
    const identity = { dev: stat.dev, ino: stat.ino, size: stat.size }
    fd = fs.openSync(file, OPEN_FLAGS)
    const bytes = boundedRead(fd, identity, limit(identity.size))
    if (bytes === undefined) return undefined
    return { ...identity, size: bytes.length, file, sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

const firstChange = (baselines: readonly Baseline[]): Mismatch | undefined => {
  for (const baseline of baselines) {
    const now = observe(baseline.file, () => baseline.size + READ_MARGIN)
    if (now === undefined || !sameFile(baseline, now)) return { file: baseline.file, field: 'state' }
    if (now.sha256 !== baseline.sha256) return { file: baseline.file, field: 'sha256' }
  }
  return undefined
}

export class SettingsWatch {
  private readonly watched = new Map<string, readonly Baseline[]>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly ledger: IntegrityLedger,
    private readonly onQuarantine: (nonce: string, mismatch: Mismatch) => void,
  ) {}

  /** Called by the launcher, in the broker, right after it writes `files` (A3 passes what writeLaunchFiles wrote). */
  register(nonce: string, files: readonly string[]): void {
    if (files.length === 0) throw new Error(`settings-watch: no files to watch for ${nonce}`)
    const baselines = files.map(file => {
      const baseline = observe(file, size => size + READ_MARGIN)
      if (baseline === undefined) throw new Error(`settings-watch: ${file} is unreadable at registration`)
      return baseline
    })
    this.watched.set(nonce, baselines)
  }

  /** Stops watching a launch whose files the launcher is about to rewrite under a new nonce. */
  forget(nonce: string): void {
    this.watched.delete(nonce)
  }

  sweep(): void {
    for (const [nonce, baselines] of this.watched) {
      const mismatch = firstChange(baselines)
      if (mismatch === undefined) continue
      const outcome = this.ledger.latch(nonce, mismatch)
      if (outcome === 'latched') this.onQuarantine(nonce, mismatch)
      if (outcome !== 'unknown') this.watched.delete(nonce)
    }
  }

  start(intervalMs: number = SETTINGS_WATCH_INTERVAL_MS): void {
    this.timer ??= setInterval(() => this.sweep(), intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}
