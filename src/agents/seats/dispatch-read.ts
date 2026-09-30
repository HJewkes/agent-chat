import path from 'node:path'
import { foldDispatch, type DispatchFold, type DispatchRecord } from './dispatch-record.js'
import { isSeatName, parseSeat } from './charter.js'
import { dispatchLogPath } from './dispatch-log.js'
import { readText } from './io.js'

/** CC-332: the reader of a seat's dispatch log. It folds with CC-328's `foldDispatch` and adds no rules of its own. */

/** A zone-less stamp or a bare date is UTC, never the machine's local time. */
const ZONE = /(?:Z|[+-]\d\d:?\d\d)$/i

/** Epoch ms of a `--since` value, or undefined when it is not a timestamp. */
export function parseSince(value: string): number | undefined {
  const v = value.trim()
  if (!/^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?/.test(v)) return undefined
  const iso = v.includes('T') || v.includes(' ') ? v.replace(' ', 'T') : `${v}T00:00:00`
  const ms = Date.parse(ZONE.test(iso) ? iso : `${iso}Z`)
  return Number.isNaN(ms) ? undefined : ms
}

/** Throws a plain message for an unknown seat, an unreadable `--since` or a missing log. */
export function readDispatches(root: string, seat: string, since?: string): DispatchFold {
  const text = isSeatName(seat) ? readText(path.join(root, 'seats', `${seat}.md`)) : undefined
  const parsed = text === undefined ? undefined : parseSeat(seat, text)
  if (text === undefined || parsed === undefined) throw new Error(`${seat} is not a seat`)
  const sinceMs = since === undefined ? undefined : parseSince(since)
  if (since !== undefined && sinceMs === undefined) {
    throw new Error(`--since ${since} is not a timestamp; use YYYY-MM-DD or an ISO time, read as UTC`)
  }
  const file = dispatchLogPath(root, { seat: parsed, text })
  if (file === undefined) throw new Error(`${seat} dispatch_log resolves outside the root`)
  const log = readText(file)
  if (log === undefined) throw new Error(`${seat} has no dispatch log at ${path.relative(root, file)}`)
  const fold = foldDispatch(log)
  if (sinceMs === undefined) return fold
  return { ...fold, records: fold.records.filter(r => r.ts !== null && Date.parse(r.ts) >= sinceMs) }
}

const dash = (v: string | number | null): string => (v === null ? '-' : String(v))

export function renderRecord(r: DispatchRecord): string {
  const spend = r.tokens === null ? '-' : `${r.tokens}${r.usage_partial ? '+' : ''}`
  return [
    dash(r.ts),
    r.agent,
    dash(r.task),
    r.outcome,
    `tokens=${spend}`,
    `usd=${dash(r.usd_est)}`,
    `pr=${dash(r.pr)}`,
    `score=${dash(r.score)}`,
  ].join('  ')
}

export function renderDispatches(fold: DispatchFold, json: boolean): string[] {
  const counts = { malformed: fold.malformed, invalid_outcomes: fold.invalid_outcomes }
  if (json) return [...fold.records.map(r => JSON.stringify(r)), JSON.stringify(counts)]
  const lines = fold.records.map(renderRecord)
  if (counts.malformed > 0 || counts.invalid_outcomes > 0) {
    lines.push(`skipped: ${counts.malformed} malformed lines, ${counts.invalid_outcomes} invalid outcomes`)
  }
  return lines
}
