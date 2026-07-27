import fs from 'node:fs'
import { logPath } from '../paths.js'

/**
 * Append-only JSONL of broker events. Every routing decision lands here, which
 * is the only external evidence that a message went to exactly one session.
 */
export function logEvent(event: string, detail: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail })
  try {
    fs.appendFileSync(logPath(), line + '\n')
  } catch {
    // The broker must not die because its log is unwritable.
  }
}
