import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { Mismatch } from '../leak-guard/integrity/record.js'
import type { IntegrityLedger } from './integrity-ledger.js'

/**
 * TP-4256 A5: the hook cannot report its own removal, so the broker keeps the sha256 of each
 * settings.json it wrote and re-hashes it on every integrity check and on a timer. A changed or
 * deleted file latches the launch's quarantine through the ledger. Nothing is restored and the agent
 * is not stopped.
 */

export const SETTINGS_WATCH_INTERVAL_MS = 60_000

const hashOf = (file: string): string | undefined => {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

export class SettingsWatch {
  private readonly watched = new Map<string, { file: string; sha256: string | undefined }>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly ledger: IntegrityLedger,
    private readonly onQuarantine: (nonce: string, mismatch: Mismatch) => void,
  ) {}

  /** Called by the launcher, in the broker, right after it writes `file`. */
  register(nonce: string, file: string): void {
    this.watched.set(nonce, { file, sha256: hashOf(file) })
  }

  sweep(): void {
    for (const [nonce, { file, sha256 }] of this.watched) {
      const now = hashOf(file)
      if (now === sha256) continue
      const mismatch = { file, field: now === undefined ? 'state' : 'sha256' }
      if (this.ledger.latch(nonce, mismatch)) this.onQuarantine(nonce, mismatch)
      this.watched.delete(nonce)
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
