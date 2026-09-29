import { claimKey, type ClaimKey } from './advance.js'
import type { Claim, Ledger } from './ledger.js'

/**
 * What changed for each seat's claims across one tick, as events the seat is told about (CC-249).
 * Pure: the caller diffs the ledger before and after execute and delivers the rendered message.
 */

export const EVENT_KINDS = ['dispatched', 'ready-to-merge', 'merged', 'stalled', 'parked'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export interface SeatEvent {
  kind: EventKind
  taskId: string
  slice?: string
  detail?: string
}

/** One spawn the tick sent; only a delivered spawn counts as a dispatch. */
export interface SpawnResult {
  key: ClaimKey
  ok: boolean
}

/** Claims of a seat's tick, by seat name. */
export type SeatEvents = Record<string, SeatEvent[]>

export const MESSAGE_LIMIT = 1500

const at = (ledger: Ledger, key: ClaimKey): Claim | undefined =>
  ledger.claims.find(c => claimKey(c) === claimKey(key))

/** Phases compared as strings: a claim read from an older ledger may carry `shepherding`. */
const transitioned = (before: Claim | undefined, after: Claim, to: string): boolean =>
  after.phase === to && (before?.phase as string | undefined) !== to

function kindsOf(before: Claim | undefined, after: Claim, spawned: boolean): SeatEvent[] {
  const event = (kind: EventKind, detail?: string): SeatEvent => ({
    kind,
    taskId: after.taskId,
    ...(after.slice === undefined ? {} : { slice: after.slice }),
    ...(detail === undefined ? {} : { detail }),
  })
  const events: SeatEvent[] = []
  if (spawned) events.push(event('dispatched'))
  if (transitioned(before, after, 'awaiting-merge')) events.push(event('ready-to-merge', after.pr))
  if (transitioned(before, after, 'done')) events.push(event('merged', after.pr))
  if (after.stalledReason !== undefined && before?.stalledReason === undefined) {
    events.push(event('stalled', after.stalledReason))
  }
  if (transitioned(before, after, 'parked')) events.push(event('parked'))
  return events
}

/** Events for claims with a seat whose `notified` lacks that kind; a claim without a seat yields none. */
export function seatEvents(before: Ledger, after: Ledger, spawnResults: readonly SpawnResult[]): SeatEvents {
  const out: SeatEvents = {}
  for (const claim of after.claims) {
    if (claim.seat === undefined) continue
    const spawned = spawnResults.some(r => r.ok && claimKey(r.key) === claimKey(claim))
    const fresh = kindsOf(at(before, claim), claim, spawned).filter(e => !claim.notified?.includes(e.kind))
    if (fresh.length > 0) (out[claim.seat] ??= []).push(...fresh)
  }
  return out
}

const line = (e: SeatEvent): string => {
  const task = e.slice === undefined ? e.taskId : `${e.taskId}#${e.slice}`
  return `${e.kind} ${task}${e.detail === undefined ? '' : `: ${e.detail}`}`
}

function overflowLine(rest: readonly SeatEvent[]): string {
  const counts = EVENT_KINDS.map(k => [k, rest.filter(e => e.kind === k).length] as const).filter(
    ([, n]) => n > 0,
  )
  return `and ${rest.length} more: ${counts.map(([k, n]) => `${n} ${k}`).join(', ')}`
}

/** One message for a seat: a header, one line per event, and counts for whatever will not fit. */
export function renderSeatEvents(seat: string, events: readonly SeatEvent[], now: Date): string {
  const header = `Burndown events for ${seat} at ${now.toISOString()}`
  const lines: string[] = []
  let used = header.length
  for (const [i, e] of events.entries()) {
    const text = line(e)
    const rest = events.slice(i + 1)
    const reserve = rest.length === 0 ? 0 : overflowLine(events.slice(i + 1)).length + 1
    if (used + text.length + 1 + reserve > MESSAGE_LIMIT - 1) {
      lines.push(overflowLine(events.slice(i)))
      break
    }
    lines.push(text)
    used += text.length + 1
  }
  return [header, ...lines].join('\n')
}
