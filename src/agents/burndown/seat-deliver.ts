import type { Ledger } from './ledger.js'
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

/** One registered connection for a whole tick's messages; the broker leases a name until the old socket's close runs. */
export interface SeatSender {
  send: SendAs
  close: () => void
}

export type OpenSender = () => Promise<SeatSender>

/** A sender that could not be opened: every seat's send fails with why, and is retried next tick. */
export const refusedSender = (reason: string): SeatSender => ({
  send: async () => ({ ok: false, reason }),
  close: () => undefined,
})

export interface DeliverDeps {
  open: OpenSender
  log: (event: string, detail: Record<string, unknown>) => void
  now: Date
}

export interface SeatDiff {
  /** Only these seats are told; a claim of any other seat keeps its events undelivered. */
  seats: readonly string[]
  before: Ledger
  after: Ledger
  spawns: readonly SpawnResult[]
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
  if (due.length === 0) return { ledger: settled.after, lines: [] }
  const sender = await deps.open().catch((err: Error) => refusedSender(err.message))
  try {
    return await sendAll(due, settled.after, sender, deps)
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
      lines.push(`told ${seat} of ${events.length} event(s)`)
    } else
      lines.push(
        `could not tell ${seat} of ${events.length} event(s): ${reply.reason ?? 'refused'}; retried next tick`,
      )
  }
  return { ledger, lines }
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
