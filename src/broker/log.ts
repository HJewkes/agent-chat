import fs from 'node:fs'
import { logPath } from '../paths.js'

const counts = new Map<string, number>()

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const CHECK_INTERVAL_BYTES = 256 * 1024

let bytesSinceCheck = 0
let checkedSinceBoot = false

function maxBytes(): number {
  const parsed = Number(process.env.AGENT_CHAT_BROKER_LOG_MAX_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES
}

/** Rename is atomic, so concurrent brokers can race here; ENOENT means a peer rotated first. */
function rotateIfOversize(): void {
  try {
    if (fs.statSync(logPath()).size > maxBytes()) fs.renameSync(logPath(), `${logPath()}.1`)
  } catch {
    // Missing file, lost race or unwritable directory: the append below decides what happens next.
  }
}

function checkSizeIfDue(): void {
  if (checkedSinceBoot && bytesSinceCheck < CHECK_INTERVAL_BYTES) return
  checkedSinceBoot = true
  bytesSinceCheck = 0
  rotateIfOversize()
}

/**
 * Append-only JSONL of broker events. Every routing decision lands here, which
 * is the only external evidence that a message went to exactly one session.
 */
export function logEvent(event: string, detail: Record<string, unknown> = {}): void {
  counts.set(event, (counts.get(event) ?? 0) + 1)
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + '\n'
  try {
    checkSizeIfDue()
    fs.appendFileSync(logPath(), line)
    bytesSinceCheck += Buffer.byteLength(line)
  } catch {
    // The broker must not die because its log is unwritable.
  }
}

/** How often this process has logged `event`: in the broker, since boot (CC-118's shadow error count). */
export function loggedCount(event: string): number {
  return counts.get(event) ?? 0
}
