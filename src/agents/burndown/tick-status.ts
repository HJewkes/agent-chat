import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'

/** How often launchd fires `burndown tick --once`; independent of any phase timeout. The status file carries it so a reader can judge a stale heartbeat. */
export const TICK_INTERVAL_SECONDS = 600

export type StopCode = 'disabled' | 'paused' | 'no-report-to'

export type TickOutcome =
  | { kind: 'ok' }
  | { kind: 'skipped' }
  | { kind: 'stopped'; reason: StopCode }
  | { kind: 'failed'; errorClass: string }

/** What one tick did, for the recorder: the lines it prints and how to count it. */
export interface TickResult {
  lines: string[]
  outcome: TickOutcome
}

export interface TickStatus {
  version: 1
  loop: 'burndown-tick'
  heartbeatAt: string
  outcome: 'ok' | 'failed' | 'stopped' | 'skipped'
  reason?: StopCode
  consecutiveFailures: number
  lastErrorClass?: string
  lastOkAt?: string
  intervalSeconds: number
}

type Log = (event: string, detail: Record<string, unknown>) => void

const CLASS_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const CREDENTIAL_SHAPE = /^(gh[pousr]_|github_pat_|eyJ)|[0-9a-fA-F]{32,}/

/** The error's `name` when it is a plain identifier, otherwise "Error"; never message text, a path or a stack. */
export function errorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined
  if (typeof name !== 'string' || !CLASS_SHAPE.test(name) || CREDENTIAL_SHAPE.test(name)) return 'Error'
  return name
}

const describeError = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err)

/** A missing, unreadable or malformed file is no history: zero failures. */
export function readTickStatus(file: string): Partial<TickStatus> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const p = parsed as Record<string, unknown>
    const n = p['consecutiveFailures']
    const lastOkAt = p['lastOkAt']
    const lastErrorClass = p['lastErrorClass']
    return {
      consecutiveFailures: typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0,
      ...(typeof lastOkAt === 'string' ? { lastOkAt } : {}),
      ...(typeof lastErrorClass === 'string' && CLASS_SHAPE.test(lastErrorClass) ? { lastErrorClass } : {}),
    }
  } catch {
    return {}
  }
}

function nextStatus(previous: Partial<TickStatus>, outcome: TickOutcome, now: Date): TickStatus {
  const count = previous.consecutiveFailures ?? 0
  const base = { version: 1, loop: 'burndown-tick', heartbeatAt: now.toISOString() } as const
  const tail = { intervalSeconds: TICK_INTERVAL_SECONDS }
  const lastOkAt = previous.lastOkAt === undefined ? {} : { lastOkAt: previous.lastOkAt }
  const carried =
    count > 0 && previous.lastErrorClass !== undefined ? { lastErrorClass: previous.lastErrorClass } : {}
  if (outcome.kind === 'ok')
    return { ...base, outcome: 'ok', consecutiveFailures: 0, lastOkAt: now.toISOString(), ...tail }
  if (outcome.kind === 'failed')
    return {
      ...base,
      outcome: 'failed',
      consecutiveFailures: count + 1,
      lastErrorClass: outcome.errorClass,
      ...lastOkAt,
      ...tail,
    }
  const reason = outcome.kind === 'stopped' ? { reason: outcome.reason } : {}
  return {
    ...base,
    outcome: outcome.kind,
    ...reason,
    consecutiveFailures: count,
    ...carried,
    ...lastOkAt,
    ...tail,
  }
}

/** Write-then-rename in the same directory, so a reader never sees half a file. */
function writeStatus(file: string, status: TickStatus): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * Runs one tick and records its heartbeat and failure count in `file`. Never
 * rejects: a throw becomes a `failed` record, one line naming the class and the
 * error itself for the local log. A
 * failed status write is logged and swallowed.
 */
export async function recordTick(
  file: string,
  tick: () => Promise<TickResult>,
  now: Date,
  log: Log = logEvent,
): Promise<string[]> {
  let result: TickResult
  try {
    result = await tick()
  } catch (err) {
    const errorClassName = errorClass(err)
    log('burndown_tick_failed', { errorClass: errorClassName })
    result = {
      // The printed lines reach the local launchd log only; the status file and event row stay class-only.
      lines: [`burndown tick failed (${errorClassName}); status in ${file}`, describeError(err)],
      outcome: { kind: 'failed', errorClass: errorClassName },
    }
  }
  try {
    writeStatus(file, nextStatus(readTickStatus(file), result.outcome, now))
  } catch (err) {
    log('burndown_status_write_failed', { errorClass: errorClass(err) })
  }
  return result.lines
}
