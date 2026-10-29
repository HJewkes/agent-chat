import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import type { ShepherdFlight } from './in-flight-read.js'
import {
  buildPacket,
  EXITED_LOOKBACK_MS,
  ownsAgent,
  type RawMessage,
  type WatchSeat,
} from './seat-watch-packet.js'
import { foldRoster, type SeatBook } from './seat-watch-read.js'
import { digestDue, watchRow, type BudgetItem, type ReadNote, type WatchRow } from './seat-watch.js'

/** CC-1661: one seat-watch pass. Every read is a port, so a test drives it with synthetic state. */

export interface WatchPorts {
  now: () => Date
  /** Re-read each pass, so a seat retired since the last one is skipped. */
  book: (rows: readonly AgentEventRow[]) => SeatBook
  owners: () => ReadonlySet<string>
  operator: string
  /** The event log's agent lifecycle rows, which the roster and the book both fold. */
  agentRows: () => AgentEventRow[]
  unread: (seat: string) => RawMessage[]
  activity: (names: readonly string[]) => Map<string, number>
  lastWords: (seat: string, sinceMs: number) => Map<string, number>
  flights: () => Promise<ShepherdFlight[]>
  budget: (seat: string) => Promise<BudgetItem>
  queue: (seat: string) => number | undefined
  /** CC-1648's dispatcher, once it covers a seat's dispatch; until then no seat is covered. */
  dispatcherCovers: (seat: string) => boolean
  lastRow: (seat: string) => WatchRow | undefined
  append: (row: WatchRow) => void
  /** Delivers a wake outside shadow mode; true when the broker took it. */
  send?: (seat: string, text: string) => Promise<boolean>
}

export interface WatchOptions {
  shadow: boolean
}

export interface WatchResult {
  rows: WatchRow[]
  retired: string[]
}

type Timed<T> = { value: T | undefined; note: ReadNote }

async function timed<T>(read: () => T | Promise<T>): Promise<Timed<T>> {
  const started = performance.now()
  const ms = (): number => Math.round(performance.now() - started)
  try {
    const value = await read()
    return { value, note: { ms: ms() } }
  } catch (err) {
    return { value: undefined, note: { ms: ms(), error: err instanceof Error ? err.message : String(err) } }
  }
}

interface Shared {
  roster: AgentIdentity[]
  flights: Timed<ShepherdFlight[]>
  rosterNote: ReadNote
}

async function seatRow(
  ports: WatchPorts,
  seat: WatchSeat,
  shared: Shared,
  opts: WatchOptions,
): Promise<WatchRow> {
  const now = ports.now()
  const nowMs = now.getTime()
  const previous = ports.lastRow(seat.name)
  const mine = shared.roster.filter(a => ownsAgent(seat, a)).map(a => a.name)
  const [unread, activity, lastWords, budget, queue] = await Promise.all([
    timed(() => ports.unread(seat.name)),
    timed(() => ports.activity(mine)),
    timed(() => ports.lastWords(seat.name, nowMs - EXITED_LOOKBACK_MS * 2)),
    timed(() => ports.budget(seat.name)),
    timed(() => ports.queue(seat.name)),
  ])
  const packet = buildPacket({
    seat,
    owners: ports.owners(),
    operator: ports.operator,
    inbox: unread.value ?? [],
    roster: shared.roster,
    activityAt: activity.value ?? new Map(),
    lastWordAt: lastWords.value ?? new Map(),
    flights: shared.flights.value ?? null,
    budget: budget.value ?? null,
    queue: queue.value ?? null,
    dispatcherCovers: ports.dispatcherCovers(seat.name),
    digestDue: digestDue(now, previous === undefined ? undefined : Date.parse(previous.at)),
    nowMs,
  })
  const reads = {
    roster: shared.rosterNote,
    shepherd: shared.flights.note,
    inbox: unread.note,
    activity: activity.note,
    lastWords: lastWords.note,
    budget: budget.note,
    queue: queue.note,
  }
  return watchRow({ now, packet, previous, shadow: opts.shadow, reads })
}

const wakeText = (row: WatchRow): string =>
  `Seat watch: ${row.fired.map(f => `${f.rule} ${f.reason}`).join('; ')} (packet ${row.hash.slice(0, 12)})`

async function deliver(ports: WatchPorts, row: WatchRow, opts: WatchOptions): Promise<WatchRow> {
  if (opts.shadow || row.decision !== 'wake') return row
  if (ports.send === undefined) throw new Error('seat watch outside shadow mode needs a sender')
  const taken = await ports.send(row.seat, wakeText(row))
  return { ...row, delivery: taken ? 'delivered' : 'refused' }
}

/** One pass: the book re-read, one row per live seat, built in parallel. In shadow mode nothing is sent. */
export async function runWatch(ports: WatchPorts, opts: WatchOptions): Promise<WatchResult> {
  if (!opts.shadow && ports.send === undefined)
    throw new Error('seat watch outside shadow mode needs a sender')
  const rows = await timed(() => ports.agentRows())
  // Without the event log no seat reads as live, so a pass that wrote nothing would look like a quiet one.
  if (rows.value === undefined) throw new Error(`agent events unreadable: ${rows.note.error}`)
  const book = ports.book(rows.value)
  const shared: Shared = {
    roster: foldRoster(rows.value),
    rosterNote: rows.note,
    flights: await timed(() => ports.flights()),
  }
  const built = await Promise.all(book.live.map(seat => seatRow(ports, seat, shared, opts)))
  const written: WatchRow[] = []
  for (const row of built) {
    const final = await deliver(ports, row, opts)
    ports.append(final)
    written.push(final)
  }
  return { rows: written, retired: book.retired }
}
