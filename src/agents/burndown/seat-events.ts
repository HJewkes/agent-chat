import { claimKey, type ClaimKey } from './advance.js'
import { checkpointHolds, undeliverable } from './checkpoint.js'
import type { Claim, Ledger } from './ledger.js'
import type { StallCode } from './stall-code.js'
import { BRAKE_WINDOW_MS, brakeSince, releasesDue, releasesSince } from './ladder.js'
import { factFingerprint } from './liveness.js'
import { ownerDue, stallDetail } from './triage.js'

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
  'released',
  'brake',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export interface SeatEvent {
  kind: EventKind
  taskId: string
  slice?: string
  detail?: string
  /** A stall's or finding's code (CC-663); a seat hears once per kind and code. */
  code?: StallCode
  /** On a brake event: the braked claims' stalls it stands for, told and journaled with it but given no line (CC-829). */
  covers?: SeatEvent[]
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
  // CC-649: while a triage job waits or runs the owner is not told; once it settles the event carries that it ran.
  if (after.stalledReason !== undefined && ownerDue(after))
    events.push(
      event('stalled', withCode(after.stallCode, stallDetail(after, after.stalledReason)), after.stallCode),
    )
  // CC-663: a dirty, uncommitted claim's notice waits one tick behind its checkpoint request.
  if (after.finding !== undefined && ownerDue(after) && !checkpointHolds(before, after))
    events.push(event('stalled-after-claim', findingDetail(after, after.finding.detail), after.finding.code))
  if (after.phase === 'parked') events.push(event('parked'))
  if (after.leak !== undefined)
    events.push(event('leak', `${after.leak.url}: ${after.leak.findings.join('; ')}`))
  return events
}

const findingDetail = (claim: Claim, detail: string): string =>
  undeliverable(claim) ? `${detail}; checkpoint undeliverable` : detail

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
  // A release or brake is told from the ledger diff, so a claim never holds it.
  if (kind === 'released' || kind === 'brake') return false
  // ready-to-merge stays on a done claim: `merged` reads it there.
  return true
}

/** Stall kinds told once per material state: a reopen with the facts last delivered wakes no one (CC-641). */
const GATED: readonly EventKind[] = ['stalled', 'stalled-after-claim']

/**
 * The facts behind a stall notice. The tick's own notes (finding body, lease timers, transcript times, triage,
 * ladder) are left out, so a transcript row the wake itself caused never re-arms it.
 */
const noticeFingerprint = (claim: Claim, e: SeatEvent): string =>
  factFingerprint({
    kind: e.kind,
    code: e.code,
    phase: claim.phase,
    agentName: claim.agentName,
    head: claim.lease?.head ?? claim.prHead,
    content: claim.lease?.content,
  })

const unchanged = (claim: Claim, e: SeatEvent): boolean =>
  GATED.includes(e.kind) && claim.noticeFacts?.[noticeKey(e)] === noticeFingerprint(claim, e)

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

/** One `brake` event per seat with a braked claim; its task names every braked claim of that seat. */
function brakeEvents(before: Ledger, after: Ledger): [string, SeatEvent][] {
  const notice = brakeSince(before, after)
  if (notice === undefined) return []
  const bySeat = new Map<string, string[]>()
  for (const { key, seat } of notice.claims)
    if (seat !== undefined) bySeat.set(seat, [...(bySeat.get(seat) ?? []), key.replace(/#$/, '')])
  const minutes = BRAKE_WINDOW_MS / 60_000
  const detail = `${notice.cause}: ${notice.count} ladder stalls in ${minutes} min; respawns and releases paused until the window clears`
  return [...bySeat].map(([seat, keys]) => [
    seat,
    { kind: 'brake', taskId: keys.join(', '), detail, code: notice.cause },
  ])
}

/**
 * One notice per seat per tick (CC-829): a braked claim's stall with the brake's cause goes inside the seat's
 * brake event rather than on a line of its own. A stall with another code keeps its line.
 */
export function foldBraked(events: SeatEvents, before: Ledger, after: Ledger): SeatEvents {
  const notice = brakeSince(before, after)
  if (notice === undefined) return events
  const braked = new Set(notice.claims.map(c => c.key))
  const folds = (e: SeatEvent): boolean =>
    e.kind === 'stalled' && e.code === notice.cause && braked.has(claimKey(e))
  const fold = (list: SeatEvent[]): SeatEvent[] => {
    const covers = list.filter(folds)
    if (covers.length === 0 || !list.some(e => e.kind === 'brake')) return list
    return list
      .filter(e => !folds(e))
      .map(e =>
        e.kind === 'brake'
          ? { ...e, detail: `${e.detail ?? ''}; each named claim is stalled for its owner`, covers }
          : e,
      )
  }
  return Object.fromEntries(Object.entries(events).map(([seat, list]) => [seat, fold(list)]))
}

/** Events for claims with a seat whose held `notified` lacks that kind, less a stall told with these facts; a claim without a seat yields none. */
export function seatEvents(before: Ledger, after: Ledger, spawnResults: readonly SpawnResult[]): SeatEvents {
  const out: SeatEvents = {}
  for (const claim of after.claims) {
    if (claim.seat === undefined) continue
    const spawned = spawnResults.some(r => r.ok && claimKey(r.key) === claimKey(claim))
    const held = heldNotified(claim)
    const fresh = kindsOf(at(before, claim), claim, spawned).filter(
      e => !told(held, e) && !unchanged(claim, e),
    )
    if (fresh.length > 0) (out[claim.seat] ??= []).push(...fresh)
  }
  for (const [seat, event] of brakeEvents(before, after)) (out[seat] ??= []).push(event)
  const made = releasesSince(before, after)
  const due = releasesDue(after).filter(d => !made.some(r => claimKey(r) === claimKey(d)))
  for (const r of [...made, ...due]) {
    if (r.seat === undefined) continue
    const detail =
      r.branch === undefined
        ? 'no branch was readable'
        : `branch ${r.branch} kept on origin if pushed; a clean pushed worktree may lose its local copy`
    ;(out[r.seat] ??= []).push({
      kind: 'released',
      taskId: r.taskId,
      ...(r.slice === undefined ? {} : { slice: r.slice }),
      detail: withCode(r.code, detail),
      ...(r.code === undefined ? {} : { code: r.code }),
    })
  }
  return out
}

/** Records a seat's delivered events on their claims, so the next tick does not send them again. */
export function markNotified(ledger: Ledger, seat: string, delivered: readonly SeatEvent[]): Ledger {
  const claims = ledger.claims.map(c => {
    if (c.seat !== seat) return c
    const mine = delivered.filter(e => claimKey(e) === claimKey(c))
    if (mine.length === 0) return c
    const notified = [...new Set([...(c.notified ?? []), ...mine.map(noticeKey)])]
    const facts = mine.filter(e => GATED.includes(e.kind)).map(e => [noticeKey(e), noticeFingerprint(c, e)])
    if (facts.length === 0) return { ...c, notified }
    return { ...c, notified, noticeFacts: { ...c.noticeFacts, ...Object.fromEntries(facts) } }
  })
  return { ...ledger, claims }
}

/** A `released` notice lives on the ladder record, not the dropped claim: due after a failed send, cleared by a delivered one. */
export function markReleaseDue(ledger: Ledger, events: readonly SeatEvent[], due: boolean): Ledger {
  const keys = events.filter(e => e.kind === 'released').map(e => claimKey(e))
  const ladder = { ...ledger.ladder }
  for (const key of keys) {
    const record = ladder[key]
    if (record === undefined || (record.releaseDue === true) === due) continue
    const { releaseDue: _was, ...rest } = record
    ladder[key] = due ? { ...rest, releaseDue: true } : rest
  }
  return keys.some(k => ladder[k] !== ledger.ladder?.[k]) ? { ...ledger, ladder } : ledger
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
