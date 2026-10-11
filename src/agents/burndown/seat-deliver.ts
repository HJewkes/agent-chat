import type { SeatMergedLog } from '../seats/dispatch-log.js'
import type { SeatJournal } from '../seats/journal.js'
import { prRef } from '../seats/journal-line.js'
import { claimKey } from './advance.js'
import { checkpointsDue, sendCheckpoints, settleCheckpoints } from './checkpoint.js'
import type { Ledger } from './ledger.js'
import { agentNameFor } from './plan.js'
import {
  EVENT_KINDS,
  foldBraked,
  markNotified,
  markReleaseDue,
  renderSeatEvents,
  seatEvents,
  settleNotified,
  type SeatEvent,
  type SeatEvents,
  type SpawnResult,
} from './seat-events.js'

/**
 * Tells each enabled seat what changed for its claims this tick, one message per seat (CC-250).
 * A delivered message marks its kinds `notified`; an undelivered one leaves them due for the next tick.
 */

/**
 * `unknown` on a failed send means the frame went out and no answer came, so it may have been delivered;
 * it is told once, never retried. Any other failure is a refusal and counts toward the wake ladder (CC-640).
 */
export type SendAs = (
  to: string,
  text: string,
) => Promise<{ ok: boolean; reason?: string; unknown?: boolean }>

/** Refused deliveries in a row after which a seat is no longer sent to and one human-queue notice is filed. */
export const WAKE_LIMIT = 3
/** A stopped seat with events due is probed with one send on every Nth such tick. */
export const WAKE_PROBE_EVERY = 5

/** Files a notice on the human queue; the broker takes one only from a registered connection. */
export type NotifyAs = (text: string, task?: string) => Promise<{ ok: boolean; reason?: string }>

/** One registered connection for a whole tick's messages; the broker leases a name until the old socket's close runs. */
export interface SeatSender {
  send: SendAs
  notify: NotifyAs
  close: () => void
}

export type OpenSender = () => Promise<SeatSender>

/** A sender that could not be opened: every seat's send fails with why, and is retried next tick. */
export const refusedSender = (reason: string): SeatSender => ({
  send: async () => ({ ok: false, reason }),
  notify: async () => ({ ok: false, reason }),
  close: () => undefined,
})

export interface DeliverDeps {
  open: OpenSender
  log: (event: string, detail: Record<string, unknown>) => void
  now: Date
  /** CC-316: writes a delivered merged or stalled event to the seat's journal. */
  journal?: SeatJournal
  /** CC-469: writes a due merged event to the seat's dispatch log, delivered or not; the writer skips a merge already there. */
  dispatch?: SeatMergedLog
}

export interface SeatDiff {
  /** Only these seats are told; a claim of any other seat keeps its events undelivered. */
  seats: readonly string[]
  before: Ledger
  after: Ledger
  spawns: readonly SpawnResult[]
  /** Human-queue items to file; each filed key is added to the ledger's `humanFiled`. */
  human?: readonly HumanItem[]
}

export interface HumanItem {
  key: string
  text: string
  task?: string
}

function dueEvents({ seats, before, after, spawns }: SeatDiff): SeatEvents {
  const all = foldBraked(seatEvents(before, after, spawns), before, after)
  return Object.fromEntries(Object.entries(all).filter(([seat]) => seats.includes(seat)))
}

export async function deliverSeatEvents(
  diff: SeatDiff,
  deps: DeliverDeps,
): Promise<{ ledger: Ledger; lines: string[] }> {
  const settled = { ...diff, after: settleNotified(settleCheckpoints(diff.after)) }
  const due = Object.entries(dueEvents(settled))
  recordMerges(due, settled.after, deps.dispatch)
  const human = diff.human ?? []
  const asking = checkpointsDue(settled.after)
  if (due.length === 0 && human.length === 0 && asking.length === 0)
    return { ledger: settled.after, lines: [] }
  const sender = await deps.open().catch((err: Error) => refusedSender(err.message))
  try {
    const asked = await sendCheckpoints(asking, settled.after, { ...deps, send: sender.send })
    const told = await sendAll(due, asked.ledger, sender, deps)
    const filed = await fileAll([...human, ...wakeNotices(due, told.ledger)], told.ledger, sender, deps)
    return { ledger: filed.ledger, lines: [...asked.lines, ...told.lines, ...filed.lines] }
  } finally {
    sender.close()
  }
}

async function sendAll(
  due: [string, SeatEvent[]][],
  start: Ledger,
  sender: SeatSender,
  deps: DeliverDeps,
): Promise<{ ledger: Ledger; lines: string[] }> {
  let ledger = start
  const lines: string[] = []
  for (const [seat, events] of due) {
    const probe = probeTurn(ledger, seat)
    if (probe.hold) {
      ledger = probe.ledger
      lines.push(`holding ${seat}'s ${events.length} event(s): ${WAKE_LIMIT} deliveries refused in a row`)
      continue
    }
    const text = renderSeatEvents(seat, events, deps.now)
    const reply = await sender.send(seat, text).catch((err: Error) => ({ ok: false, reason: err.message }))
    const unknown = 'unknown' in reply && reply.unknown === true
    deps.log('burndown_seat_events', {
      seat,
      events: events.length,
      ok: reply.ok,
      unknown,
      reason: reply.reason,
    })
    const told = events.flatMap(e => [e, ...(e.covers ?? [])])
    if (reply.ok || unknown) {
      ledger = markReleaseDue(markNotified(ledger, seat, told), told, false)
      journalEvents(told, ledger, deps.journal)
      ledger = reply.ok ? clearWake(ledger, seat) : ledger
      lines.push(
        reply.ok
          ? `told ${seat} of ${events.length} event(s)`
          : `sent ${seat} ${events.length} event(s) with no answer (${reply.reason ?? 'unknown'}); not retried`,
      )
    } else {
      ledger = failWake(markReleaseDue(ledger, events, true), seat, reply.reason)
      lines.push(
        `could not tell ${seat} of ${events.length} event(s): ${reply.reason ?? 'refused'}; retried next tick`,
      )
    }
  }
  return { ledger, lines }
}

const wakeKey = (seat: string): string => `wake:${seat}`

/** A stopped seat is held back except on every Nth tick, when it is sent one probe. */
function probeTurn(ledger: Ledger, seat: string): { hold: boolean; ledger: Ledger } {
  const rec = ledger.wake?.[seat]
  if (rec === undefined || rec.failed < WAKE_LIMIT) return { hold: false, ledger }
  const skipped = (rec.skipped ?? 0) + 1
  const probing = skipped >= WAKE_PROBE_EVERY
  const next = { ...rec, skipped: probing ? 0 : skipped }
  return { hold: !probing, ledger: { ...ledger, wake: { ...ledger.wake, [seat]: next } } }
}

function failWake(ledger: Ledger, seat: string, reason: string | undefined): Ledger {
  const failed = (ledger.wake?.[seat]?.failed ?? 0) + 1
  const skipped = ledger.wake?.[seat]?.skipped
  const rec = {
    failed,
    ...(reason === undefined ? {} : { reason }),
    ...(skipped === undefined ? {} : { skipped }),
  }
  return { ...ledger, wake: { ...ledger.wake, [seat]: rec } }
}

/** A delivered message closes the seat's record and its open notice, so a later stop files a new one. */
function clearWake(ledger: Ledger, seat: string): Ledger {
  const { [seat]: _gone, ...wake } = ledger.wake ?? {}
  const { wake: _old, ...rest } = ledger
  const humanFiled = (ledger.humanFiled ?? []).filter(k => k !== wakeKey(seat))
  const cleared = Object.keys(wake).length === 0 ? rest : { ...rest, wake }
  if (ledger.humanFiled === undefined) return cleared
  const { humanFiled: _filed, ...bare } = cleared
  return humanFiled.length === 0 ? bare : { ...bare, humanFiled }
}

/** One notice per stopped seat, counting its pending events by kind; it stays unfiled-and-retried until the broker takes it. */
function wakeNotices(due: [string, SeatEvent[]][], ledger: Ledger): HumanItem[] {
  return due.flatMap(([seat, events]) => {
    const rec = ledger.wake?.[seat]
    if (rec === undefined || rec.failed < WAKE_LIMIT) return []
    if ((ledger.humanFiled ?? []).includes(wakeKey(seat))) return []
    const counts = EVENT_KINDS.map(k => [k, events.filter(e => e.kind === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
    const text =
      `Seat ${seat} has refused ${rec.failed} deliveries in a row (last: ${rec.reason ?? 'refused'}); ` +
      `no more are sent until it answers a probe. Pending: ${counts.join(', ')}.`
    return [{ key: wakeKey(seat), text }]
  })
}

/** Written once delivered, so an event retried next tick is never journaled twice; the line names the claim's implementer. */
function journalEvents(events: readonly SeatEvent[], ledger: Ledger, journal?: SeatJournal): void {
  for (const e of events) {
    const claim = ledger.claims.find(c => claimKey(c) === claimKey(e))
    if (claim === undefined || (e.kind !== 'merged' && e.kind !== 'stalled')) continue
    const agent = agentNameFor(claim.taskId, claim.slice, claim.namePrefix)
    const pr = prRef(claim.pr, claim.prHead)
    journal?.({ event: e.kind, task: claim.taskId, agent, ...(pr === undefined ? {} : { pr }) })
  }
}

/** `owner/repo#n` of a pull request URL. */
const prNumberRef = (url: string | undefined): string | undefined => {
  const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url ?? '')
  return m === null ? undefined : `${m[1]}#${m[2]}`
}

/** One merged row per merged claim, named for the claim's implementer as the journal line is. */
function recordMerges(due: [string, SeatEvent[]][], ledger: Ledger, dispatch?: SeatMergedLog): void {
  if (dispatch === undefined) return
  for (const [seat, events] of due) {
    for (const e of events.filter(ev => ev.kind === 'merged')) {
      const claim = ledger.claims.find(c => claimKey(c) === claimKey(e))
      const pr = prNumberRef(claim?.pr)
      if (claim === undefined || pr === undefined) continue
      dispatch({ agent: agentNameFor(claim.taskId, claim.slice, claim.namePrefix), pr, seat })
    }
  }
}

async function fileAll(
  items: readonly HumanItem[],
  start: Ledger,
  sender: SeatSender,
  deps: DeliverDeps,
): Promise<{ ledger: Ledger; lines: string[] }> {
  const filed: string[] = []
  const lines: string[] = []
  for (const item of items) {
    const reply = await sender
      .notify(item.text, item.task)
      .catch((err: Error) => ({ ok: false, reason: err.message }))
    deps.log('burndown_human_item', { key: item.key, ok: reply.ok, reason: reply.reason })
    if (reply.ok) filed.push(item.key)
    else lines.push(`could not file a human-queue item: ${reply.reason ?? 'refused'}; retried next tick`)
  }
  if (filed.length > 0) lines.push(`filed ${filed.length} human-queue item(s)`)
  const humanFiled = [...new Set([...(start.humanFiled ?? []), ...filed])]
  return { ledger: humanFiled.length === 0 ? start : { ...start, humanFiled }, lines }
}

/** The dry run's view: each message the tick would send, verbatim. */
export function describeSeatEvents(diff: SeatDiff, now: Date): string[] {
  const settled = { ...diff, after: settleCheckpoints(diff.after) }
  const asks = checkpointsDue(settled.after).map(
    c => `would ask ${c.agentName} for a checkpoint of ${c.taskId}`,
  )
  return [...asks, ...describeEvents(settled, now)]
}

function describeEvents(diff: SeatDiff, now: Date): string[] {
  return Object.entries(dueEvents(diff)).flatMap(([seat, events]) => [
    `would send to ${seat}:`,
    ...renderSeatEvents(seat, events, now)
      .split('\n')
      .map(l => `  ${l}`),
  ])
}
