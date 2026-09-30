import type { SeatJournal } from '../seats/journal.js'
import { prRef } from '../seats/journal-line.js'
import { claimKey } from './advance.js'
import type { Ledger } from './ledger.js'
import { agentNameFor } from './plan.js'
import {
  markNotified,
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

export type SendAs = (to: string, text: string) => Promise<{ ok: boolean; reason?: string }>

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
  const all = seatEvents(before, after, spawns)
  return Object.fromEntries(Object.entries(all).filter(([seat]) => seats.includes(seat)))
}

export async function deliverSeatEvents(
  diff: SeatDiff,
  deps: DeliverDeps,
): Promise<{ ledger: Ledger; lines: string[] }> {
  const settled = { ...diff, after: settleNotified(diff.after) }
  const due = Object.entries(dueEvents(settled))
  const human = diff.human ?? []
  if (due.length === 0 && human.length === 0) return { ledger: settled.after, lines: [] }
  const sender = await deps.open().catch((err: Error) => refusedSender(err.message))
  try {
    const told = await sendAll(due, settled.after, sender, deps)
    const filed = await fileAll(human, told.ledger, sender, deps)
    return { ledger: filed.ledger, lines: [...told.lines, ...filed.lines] }
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
    const text = renderSeatEvents(seat, events, deps.now)
    const reply = await sender.send(seat, text).catch((err: Error) => ({ ok: false, reason: err.message }))
    deps.log('burndown_seat_events', { seat, events: events.length, ok: reply.ok, reason: reply.reason })
    if (reply.ok) {
      ledger = markNotified(ledger, seat, events)
      journalEvents(events, ledger, deps.journal)
      lines.push(`told ${seat} of ${events.length} event(s)`)
    } else
      lines.push(
        `could not tell ${seat} of ${events.length} event(s): ${reply.reason ?? 'refused'}; retried next tick`,
      )
  }
  return { ledger, lines }
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
  return Object.entries(dueEvents(diff)).flatMap(([seat, events]) => [
    `would send to ${seat}:`,
    ...renderSeatEvents(seat, events, now)
      .split('\n')
      .map(l => `  ${l}`),
  ])
}
