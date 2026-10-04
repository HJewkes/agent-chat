import { claimKey, type ClaimKey } from './advance.js'
import type { Claim, Ledger } from './ledger.js'
import type { StallCode } from './stall-code.js'

/**
 * What changed for each seat's claims across one tick, as events the seat is told about (CC-249).
 * Pure: the caller diffs the ledger before and after execute and delivers the rendered message.
 */

export const EVENT_KINDS = [
  'dispatched',
  'ready-to-merge',
  'merged',
  'stalled',
  'stalled-after-claim',
  'parked',
  'leak',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export interface SeatEvent {
  kind: EventKind
  taskId: string
  slice?: string
  detail?: string
  /** A stall's or finding's code (CC-663); a seat hears once per kind and code. */
  code?: StallCode
}

/** One spawn the tick sent; only a delivered spawn counts as a dispatch. */
export interface SpawnResult {
  key: ClaimKey
  ok: boolean
}

/** Claims of a seat's tick, by seat name. */
export type SeatEvents = Record<string, SeatEvent[]>

export const MESSAGE_LIMIT = 1500

/** A longer seat name is cut in the header, which would otherwise crowd out every event line. */
const SEAT_SHOWN = 100

const at = (ledger: Ledger, key: ClaimKey): Claim | undefined =>
  ledger.claims.find(c => claimKey(c) === claimKey(key))

/** Phases compared as strings: a claim read from an older ledger may carry `shepherding`. */
const MERGE_PHASES: readonly string[] = ['awaiting-merge', 'shepherding']

/** Only a merge moves a claim from awaiting-merge to done, so a delivered ready-to-merge on a done claim means merged. */
const merged = (before: Claim | undefined, after: Claim): boolean =>
  after.phase === 'done' &&
  (MERGE_PHASES.includes(before?.phase ?? '') || after.notified?.includes('ready-to-merge') === true)

/** Kinds the claim's state holds now; `notified` drops the delivered ones, so an undelivered kind is due again next tick. */
function kindsOf(before: Claim | undefined, after: Claim, spawned: boolean): SeatEvent[] {
  const event = (kind: EventKind, detail?: string, code?: StallCode): SeatEvent => ({
    kind,
    taskId: after.taskId,
    ...(after.slice === undefined ? {} : { slice: after.slice }),
    ...(detail === undefined ? {} : { detail }),
    ...(code === undefined ? {} : { code }),
  })
  const events: SeatEvent[] = []
  if (spawned || after.agentId !== undefined) events.push(event('dispatched'))
  if (after.phase === 'awaiting-merge') events.push(event('ready-to-merge', after.pr))
  if (merged(before, after)) events.push(event('merged', after.pr))
  if (after.stalledReason !== undefined)
    events.push(event('stalled', withCode(after.stallCode, after.stalledReason), after.stallCode))
  if (after.finding !== undefined)
    events.push(event('stalled-after-claim', after.finding.detail, after.finding.code))
  if (after.phase === 'parked') events.push(event('parked'))
  if (after.leak !== undefined)
    events.push(event('leak', `${after.leak.url}: ${after.leak.findings.join('; ')}`))
  return events
}

const withCode = (code: StallCode | undefined, reason: string): string =>
  code === undefined ? reason : `${code}: ${reason}`

/** The `notified` entry for an event: `kind`, or `kind:code` for a coded stall or finding. */
const noticeKey = (e: SeatEvent): string => (e.code === undefined ? e.kind : `${e.kind}:${e.code}`)

/** A bare kind told before CC-663 counts as told for any code, so a deploy does not re-notify open stalls. */
const told = (notified: readonly string[], e: SeatEvent): boolean =>
  notified.includes(noticeKey(e)) || notified.includes(e.kind)

/** A coded entry holds only while the claim carries that code; a bare one holds for any. */
const sameCode = (code: string | undefined, now: StallCode | undefined): boolean =>
  code === undefined || code === now

/** Whether a delivered kind still describes the claim; once it does not, the kind may fire again (a second park). */
function stillHolds(claim: Claim, entry: string): boolean {
  const [kind, code] = entry.split(':', 2)
  if (kind === 'parked') return claim.phase === 'parked'
  if (kind === 'stalled') return claim.stalledReason !== undefined && sameCode(code, claim.stallCode)
  if (kind === 'stalled-after-claim') return claim.finding !== undefined && sameCode(code, claim.finding.code)
  if (kind === 'leak') return claim.leak !== undefined
  // ready-to-merge stays on a done claim: `merged` reads it there.
  return true
}

const heldNotified = (claim: Claim): string[] => (claim.notified ?? []).filter(k => stillHolds(claim, k))

/** Drops each delivered kind the claim has since left, so the ledger keeps only what still holds. */
export function settleNotified(ledger: Ledger): Ledger {
  const claims = ledger.claims.map(c => {
    if (c.notified === undefined) return c
    const held = heldNotified(c)
    if (held.length === c.notified.length) return c
    const { notified: _dropped, ...rest } = c
    return held.length === 0 ? rest : { ...rest, notified: held }
  })
  return { ...ledger, claims }
}

/** Events for claims with a seat whose held `notified` lacks that kind; a claim without a seat yields none. */
export function seatEvents(before: Ledger, after: Ledger, spawnResults: readonly SpawnResult[]): SeatEvents {
  const out: SeatEvents = {}
  for (const claim of after.claims) {
    if (claim.seat === undefined) continue
    const spawned = spawnResults.some(r => r.ok && claimKey(r.key) === claimKey(claim))
    const held = heldNotified(claim)
    const fresh = kindsOf(at(before, claim), claim, spawned).filter(e => !told(held, e))
    if (fresh.length > 0) (out[claim.seat] ??= []).push(...fresh)
  }
  return out
}

/** Records a seat's delivered events on their claims, so the next tick does not send them again. */
export function markNotified(ledger: Ledger, seat: string, delivered: readonly SeatEvent[]): Ledger {
  const claims = ledger.claims.map(c => {
    if (c.seat !== seat) return c
    const kinds = delivered.filter(e => claimKey(e) === claimKey(c)).map(noticeKey)
    if (kinds.length === 0) return c
    return { ...c, notified: [...new Set([...(c.notified ?? []), ...kinds])] }
  })
  return { ...ledger, claims }
}

const line = (e: SeatEvent): string => {
  const task = e.slice === undefined ? e.taskId : `${e.taskId}#${e.slice}`
  return `${e.kind} ${task}${e.detail === undefined ? '' : `: ${e.detail}`}`
}

function overflowLine(rest: readonly SeatEvent[]): string {
  const counts = EVENT_KINDS.map(k => [k, rest.filter(e => e.kind === k).length] as const).filter(
    ([, n]) => n > 0,
  )
  return `and ${rest.length} more: ${counts.map(([k, n]) => `${n} ${k}`).join(', ')}; run burndown status for them`
}

/** One message for a seat: a header, one line per event, and counts for whatever will not fit; the counted ones count as told. */
export function renderSeatEvents(seat: string, events: readonly SeatEvent[], now: Date): string {
  const shown = seat.length > SEAT_SHOWN ? `${seat.slice(0, SEAT_SHOWN)}...` : seat
  const header = `Burndown events for ${shown} at ${now.toISOString()}`
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
