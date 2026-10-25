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

type Baseline = { file: string; sha256: string }

const hashOf = (file: string): string | undefined => {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

const firstChange = (baselines: readonly Baseline[]): Mismatch | undefined => {
  for (const { file, sha256 } of baselines) {
    const now = hashOf(file)
    if (now !== sha256) return { file, field: now === undefined ? 'state' : 'sha256' }
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
    const baselines = files.map(file => {
      const sha256 = hashOf(file)
      if (sha256 === undefined) throw new Error(`settings-watch: ${file} is unreadable at registration`)
      return { file, sha256 }
    })
    this.watched.set(nonce, baselines)
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
