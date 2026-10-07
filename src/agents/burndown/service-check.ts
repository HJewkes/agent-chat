import { z } from 'zod'
import { run, type Runner } from './exec.js'
import type { LineStop } from './flow-gate.js'
import { SHEPHERD_BIN } from './shepherd.js'
import { TICK_INTERVAL_SECONDS } from './tick-status.js'

/**
 * CC-629 S3: the stop-the-line read. `titan-factory service check --json` prints one object
 * `{ok, cause, message, pid?, health, detail}` and exits 0 when ok, 1 when not; `cause` names the
 * first failing check. One failed /health probe can read as `stale pid` while serve is healthy
 * (TP-1726), so one stopping read never stops the line: this read and the previous persisted one
 * must both stop, and the previous must be recent.
 */

/** A failing exec, a timeout, or output that is not the check's JSON. */
export const UNREADABLE = 'unreadable'

/** Causes that stop new implementers. A cause this build does not know stops too: the check failed for a reason nobody has judged harmless. */
const NOTE_CAUSES: ReadonlySet<string> = new Set([
  // serve still merges on an old build; it is a restart hint.
  'stale build',
  // These describe the burndown tick itself, so stopping on them would make the tick block itself.
  'tick failing',
  'tick stale',
])

/** The previous read counts only while it is at most this old, so a tick that skipped runs starts the two reads again. */
export const SERVICE_CHECK_WINDOW_MS = 2 * TICK_INTERVAL_SECONDS * 1000

const CHECK_EXITS: ReadonlySet<number | null> = new Set([0, 1])

const CheckJson = z.object({ ok: z.boolean(), cause: z.string().nullable(), message: z.string() })

export interface ServiceRead {
  /** Null when the check passed. */
  cause: string | null
  message: string
}

/** What the ledger keeps of a read: when, and its cause. */
export interface PersistedRead {
  at: string
  cause: string | null
}

/** One exec of the check; every way it can fail to answer is a read with cause `unreadable`. */
export function readServiceCheck(exec: Runner = run): ServiceRead {
  const result = exec(SHEPHERD_BIN, ['service', 'check', '--json'])
  if (!CHECK_EXITS.has(result.status))
    return {
      cause: UNREADABLE,
      message: `titan-factory service check exited ${result.status ?? 'abnormally'}`,
    }
  const parsed = parseCheck(result.stdout)
  if (parsed === undefined)
    return { cause: UNREADABLE, message: 'titan-factory service check printed no check result' }
  if (parsed.ok) return { cause: null, message: parsed.message }
  return { cause: parsed.cause ?? UNREADABLE, message: parsed.message }
}

function parseCheck(stdout: string): z.infer<typeof CheckJson> | undefined {
  try {
    const parsed = CheckJson.safeParse(JSON.parse(stdout))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

const isStopping = (cause: string | null): cause is string => cause !== null && !NOTE_CAUSES.has(cause)

/** Set only when this read and a previous one inside the window both stop; an ok read clears it at once. */
export function lineStopFrom(
  current: ServiceRead,
  previous: PersistedRead | undefined,
  now: Date,
): LineStop | undefined {
  if (!isStopping(current.cause) || previous === undefined || !isStopping(previous.cause)) return undefined
  if (now.getTime() - Date.parse(previous.at) > SERVICE_CHECK_WINDOW_MS) return undefined
  return { previous: previous.cause, current: current.cause, message: current.message }
}

/** A note-only cause is reported on the tick, never stopped on. */
export function serviceCheckNote(current: ServiceRead): string | undefined {
  if (current.cause === null || isStopping(current.cause)) return undefined
  return `service check: ${current.cause} (a note, the line runs): ${current.message}`
}

export const persisted = (current: ServiceRead, now: Date): PersistedRead => ({
  at: now.toISOString(),
  cause: current.cause,
})
