import fs from 'node:fs'
import { logPath } from '../paths.js'

const counts = new Map<string, number>()

/**
 * Append-only JSONL of broker events. Every routing decision lands here, which
 * is the only external evidence that a message went to exactly one session.
 */
export function logEvent(event: string, detail: Record<string, unknown> = {}): void {
  counts.set(event, (counts.get(event) ?? 0) + 1)
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail })
  try {
    fs.appendFileSync(logPath(), line + '\n')
  } catch {
    // The broker must not die because its log is unwritable.
  }
}

/** How often this process has logged `event`: in the broker, since boot (CC-118's shadow error count). */
export function loggedCount(event: string): number {
  return counts.get(event) ?? 0
}
