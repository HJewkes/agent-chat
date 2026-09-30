/**
 * A seat's dispatch log: the rows the broker appends and the one record per agent run a reader folds (CC-328).
 *
 * The log has two writers and neither rewrites the other's line. The broker knows a spawn and a retire, with
 * the spend; the seat knows how the work ended. A reader therefore never trusts a single row.
 * A broker retire joins the run holding its agent_id, else the previous run of the name. So a run with no row
 * carrying its agent_id (lost dispatched line, no seat row) attaches its spend to the previous run of that name.
 * Pure: the writer and the reader do the I/O.
 */

/** The end states only a seat can know. */
export const SEAT_OUTCOMES = ['merged', 'done', 'parked', 'stalled', 'abandoned'] as const
export type SeatOutcome = (typeof SEAT_OUTCOMES)[number]

export const DISPATCHED = 'dispatched'
/** Broker-only: the agent ended and this row holds no seat outcome. */
export const RETIRED = 'retired'

const BROKER = 'broker'

/** What the broker knows about one agent run. `task` is the caller's to resolve. */
export interface DispatchRun {
  ts: string
  task: string | null
  initiative: string | null
  kind: string | null
  profile: string | null
  agent: string
  agent_id: string
  spawner: string | null
  model: string | null
  predecessor: string | null
}

export interface DispatchUsage {
  input: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  output: number
}

export interface DispatchSpend {
  tokens: number
  usd_est: number | null
  usage: DispatchUsage
  models: string[]
  price_table: number
}

/** A failed usage read still writes the row, with the reason in place of the spend. */
export type RetireSpend = DispatchSpend | { usage_miss: string }

interface BrokerRow<Outcome extends string> {
  ts: string
  task: string | null
  initiative: string | null
  kind: string | null
  score: null
  profile: string | null
  agent: string
  pr: null
  outcome: Outcome
  note: null
  tokens: number | null
  usd_est: number | null
  value: null
  by: typeof BROKER
  agent_id: string
  spawner: string | null
  model: string | null
  predecessor: string | null
}

export type DispatchedRow = BrokerRow<typeof DISPATCHED>

export interface RetiredRow extends BrokerRow<typeof RETIRED> {
  session_id: string | null
  usage?: DispatchUsage
  models?: string[]
  price_table?: number
  usage_miss?: string
}

/** Every broker row carries every record key, so a seat-owned one it cannot know is an explicit null. */
function brokerRow<Outcome extends string>(
  run: DispatchRun,
  outcome: Outcome,
  tokens: number | null,
  usdEst: number | null,
): BrokerRow<Outcome> {
  return {
    ts: run.ts,
    task: run.task,
    initiative: run.initiative,
    kind: run.kind,
    score: null,
    profile: run.profile,
    agent: run.agent,
    pr: null,
    outcome,
    note: null,
    tokens,
    usd_est: usdEst,
    value: null,
    by: BROKER,
    agent_id: run.agent_id,
    spawner: run.spawner,
    model: run.model,
    predecessor: run.predecessor,
  }
}

export const dispatchedRow = (run: DispatchRun): DispatchedRow => brokerRow(run, DISPATCHED, null, null)

/** Broker-written end state for a dispatched agent that never attached; no seat exists to write it. */
export const abandonedRow = (run: DispatchRun): BrokerRow<'abandoned'> =>
  brokerRow(run, 'abandoned', null, null)

export function retiredRow(run: DispatchRun, sessionId: string | null, spend: RetireSpend): RetiredRow {
  if ('usage_miss' in spend) {
    return { ...brokerRow(run, RETIRED, null, null), session_id: sessionId, usage_miss: spend.usage_miss }
  }
  return {
    ...brokerRow(run, RETIRED, spend.tokens, spend.usd_est),
    session_id: sessionId,
    usage: spend.usage,
    models: spend.models,
    price_table: spend.price_table,
  }
}

export type Scalar = string | number | null

/** One agent run, whichever order its rows were appended in. */
export interface DispatchRecord {
  ts: string | null
  task: string | null
  initiative: string | null
  kind: string | null
  score: Scalar
  profile: string | null
  agent: string
  pr: Scalar
  outcome: SeatOutcome | typeof RETIRED | typeof DISPATCHED
  note: Scalar
  tokens: number | null
  usd_est: number | null
  /** True when a session's usage read missed, so `tokens` leaves that session out. */
  usage_partial: boolean
  value: Scalar
  agent_id: string | null
  spawner: string | null
  model: string | null
  predecessor: string | null
}

export interface DispatchFold {
  records: DispatchRecord[]
  /** Lines that are not a JSON object with a string `agent`. */
  malformed: number
  /** Seat rows whose outcome is not an end state; the rest of such a row still counts. */
  invalid_outcomes: number
}

type Row = Record<string, unknown> & { agent: string }

export function foldDispatch(text: string): DispatchFold {
  const groups: Row[][] = []
  const byName = new Map<string, Row[][]>()
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const row = parseRow(line)
    if (row === undefined) {
      malformed++
      continue
    }
    const named = byName.get(row.agent) ?? []
    const open = groupOf(row, named)
    if (open !== undefined) {
      open.push(row)
      continue
    }
    const group = [row]
    groups.push(group)
    named.push(group)
    byName.set(row.agent, named)
  }
  return {
    records: groups.map(recordOf),
    malformed,
    invalid_outcomes: groups.flat().filter(hasInvalidOutcome).length,
  }
}

function parseRow(line: string): Row | undefined {
  try {
    const doc: unknown = JSON.parse(line)
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined
    return typeof (doc as Record<string, unknown>).agent === 'string' ? (doc as Row) : undefined
  } catch {
    return undefined
  }
}

/** The run a row belongs to among those of its name, or undefined when it starts a new one. */
function groupOf(row: Row, named: readonly Row[][]): Row[] | undefined {
  const latest = named.at(-1)
  if (latest === undefined) return undefined
  const id = text(row.agent_id)
  if ((row.outcome === RETIRED || row.outcome === 'abandoned') && isBroker(row) && id !== null) {
    return named.findLast(g => g.some(r => r.agent_id === id)) ?? latest
  }
  return opensGroup(row, latest) ? undefined : latest
}

/** A name is reused across runs, so a second `dispatched` starts a run once the first has ended or names another agent. */
function opensGroup(row: Row, group: readonly Row[]): boolean {
  if (row.outcome !== DISPATCHED) return false
  // The broker's retire is not the end of a seat's own `dispatched`, which may be written after it.
  if (group.some(r => r.outcome !== DISPATCHED && (isBroker(row) || !isBroker(r)))) return true
  const id = text(row.agent_id)
  return id !== null && group.some(r => text(r.agent_id) !== null && r.agent_id !== id)
}

function recordOf(group: readonly Row[]): DispatchRecord {
  const broker = group.filter(isBroker)
  const seat = group.filter(r => !isBroker(r))
  // A group with no broker row predates the broker's writes, so the seat's own values stand in.
  const owner = broker.length > 0 ? broker : seat
  const filled = (key: string): string | null => lastOf(seat, key, text) ?? firstOf(broker, key, text)
  return {
    ts: firstOf(owner, 'ts', text),
    task: filled('task'),
    initiative: filled('initiative'),
    kind: filled('kind'),
    score: lastOf(seat, 'score', scalar),
    profile: firstOf(owner, 'profile', text),
    agent: (group[0] as Row).agent,
    pr: lastOf(seat, 'pr', scalar),
    outcome: outcomeOf(broker, seat),
    note: lastOf(seat, 'note', scalar),
    ...(broker.length > 0 ? brokerSpend(broker) : seatSpend(seat)),
    value: lastOf(seat, 'value', scalar),
    agent_id: firstOf(owner, 'agent_id', text),
    spawner: firstOf(owner, 'spawner', text),
    model: firstOf(owner, 'model', text),
    predecessor: firstOf(owner, 'predecessor', text),
  }
}

/** The seat's end state outranks the broker's `retired` wherever either sits in the file. */
function outcomeOf(broker: readonly Row[], seat: readonly Row[]): DispatchRecord['outcome'] {
  const ended = seat.map(r => r.outcome).findLast(isSeatOutcome)
  if (ended !== undefined) return ended
  if (broker.some(r => r.outcome === 'abandoned')) return 'abandoned'
  return broker.some(r => r.outcome === RETIRED) ? RETIRED : DISPATCHED
}

type Spend = Pick<DispatchRecord, 'tokens' | 'usd_est' | 'usage_partial'>

/** A retire row reads the whole transcript, so a session retired twice counts its last read and not both. */
function brokerSpend(broker: readonly Row[]): Spend {
  const bySession = new Map<string | null, Row>()
  for (const row of broker) {
    if (row.outcome === RETIRED && count(row.tokens) !== null) bySession.set(text(row.session_id), row)
  }
  const read = [...bySession.values()]
  const sessions = new Set(broker.filter(r => r.outcome === RETIRED).map(r => text(r.session_id)))
  const usage_partial = sessions.size > read.length
  if (read.length === 0) return { tokens: null, usd_est: null, usage_partial }
  const usd = read.map(r => count(r.usd_est))
  return {
    tokens: sum(read.map(r => count(r.tokens))),
    usd_est: usd.includes(null) ? null : Math.round(sum(usd) * 1e4) / 1e4,
    usage_partial,
  }
}

const seatSpend = (seat: readonly Row[]): Spend => ({
  tokens: lastOf(seat, 'tokens', count),
  usd_est: lastOf(seat, 'usd_est', count),
  usage_partial: false,
})

const isBroker = (row: Row): boolean => row.by === BROKER

const isSeatOutcome = (v: unknown): v is SeatOutcome => SEAT_OUTCOMES.includes(v as SeatOutcome)

const hasInvalidOutcome = (row: Row): boolean =>
  !isBroker(row) && row.outcome != null && row.outcome !== DISPATCHED && !isSeatOutcome(row.outcome)

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const scalar = (v: unknown): Scalar => text(v) ?? count(v)

const sum = (values: readonly (number | null)[]): number => values.reduce<number>((a, b) => a + (b ?? 0), 0)

type Reader<T> = (v: unknown) => T | null

function firstOf<T>(rows: readonly Row[], key: string, read: Reader<T>): T | null {
  for (const row of rows) {
    const value = read(row[key])
    if (value !== null) return value
  }
  return null
}

const lastOf = <T>(rows: readonly Row[], key: string, read: Reader<T>): T | null =>
  firstOf(rows.toReversed(), key, read)
