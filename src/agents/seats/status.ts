import fs from 'node:fs'
import path from 'node:path'
import type { AgentIdentity } from '../../protocol.js'
import type { BudgetRead } from '../budget.js'
import {
  dayStart,
  gatePool,
  runStartAt,
  type AccountReading,
  type PoolGateResult,
} from '../burndown/budget-gate.js'
import { loadPolicy, seatBudget, type Policy } from '../burndown/policy.js'
import type { ScoredPlan } from '../burndown/score-render.js'
import type { DispatchRow } from '../burndown/score.js'
import { expandHome } from '../burndown/seat-dispatch.js'
import { localDate } from '../burndown/seat-tick.js'
import { openEvents, type WatchdogDoc } from './io.js'
import { advanceMeter, meterHistory, sameSpendDay, withinRun, type SpendMeter } from './stops.js'
import { accountReading, lastGoodReading } from './watchdog.js'
import type { MachineStatus } from '../machine-guard.js'

/**
 * CC-317: what a coordinator seat reads before it dispatches, in one call.
 * Read-only: the spend meters are advanced in memory and never saved.
 */

/** How many of the scorer's rows a tick looks at. */
export const STATUS_TOP = 3

export interface AgentLoad {
  active: number
  names: string[]
  /** Those of `names` with no connected session; they count as active because the process may still be running. */
  detached: string[]
}

export interface RoleLoad extends AgentLoad {
  cap: number
  atCap: boolean
}

export interface ParkedLoad {
  /** The seat's implementers that exited and are not retired. */
  count: number
  names: string[]
  /** Those whose worktree checkout is still on disk, so `agent park` has not run for them. */
  treeOnDisk: string[]
}

export interface BudgetStatus {
  pool: string | null
  sevenDay: number | null
  fiveHour: number | null
  /** Seconds since the pool's freshest status file was written; null with no reading. */
  ageSeconds: number | null
  stale: boolean
  /** CC-409: the current reading lacks a window, so the figures are the pool's last good reading, within its limits. */
  staleOk: boolean
  /** The charter stop that closes the seat's gate, or null when it is open. */
  stop: string | null
  /** The open gate's figures against its lines. */
  margin: string | null
  sonnetOnly: boolean
  /** Set when the day's spend is counted from the saved meter's first sample, which came after 07:00. */
  spendSince: string | null
  note: string | null
}

export interface InboxReading {
  /** Messages to the seat since its own last send; the broker keeps no read cursor. Null when events.db cannot be read. */
  unread: number | null
  sinceLastSend: string | null
  error?: string
}

export interface EligibleTask {
  id: string
  initiative: string
  title: string
  kind: string
  route: string
  /** The score after initiative decay, which orders dispatch. */
  score: number
  rawScore: number
}

export interface EligibleStatus {
  top: EligibleTask[]
  /** Malformed tasks the scorer left out. */
  skipped: number
  today: string
  error?: string
}

export interface SeatStatus {
  seat: string
  at: string
  implementers: RoleLoad
  reviewers: RoleLoad
  planners: RoleLoad
  /** Running agents of the seat whose profile names none of the three roles; no cap applies. */
  other: AgentLoad
  parked: ParkedLoad
  budget: BudgetStatus
  inbox: InboxReading
  eligible: EligibleStatus
  /** CC-406: the machine-wide guard's readings against its limits, across every seat. */
  machine: MachineStatus
}

export interface StatusDeps {
  now: () => Date
  autonomyRoot: string
  homeDir: string
  /** The broker's roster without retired agents. */
  agents: () => Promise<AgentIdentity[]>
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  /** Throws when seat-watchdog.json exists and cannot be read or parsed. */
  loadDoc: () => WatchdogDoc
  /** Throws when events.db cannot be read. */
  inbox: (seat: string) => InboxReading
  scored: (seat: string, today: string) => ScoredPlan
  /** Given the whole roster, not the seat's share of it. */
  machine: (agents: AgentIdentity[]) => MachineStatus
}

const INBOX_KINDS = "'message', 'broadcast', 'answer', 'decided'"
// A tag or a question by the seat is not a reply, so neither moves the cutoff.
const SENT_KINDS = "'message', 'broadcast'"

/** The error's text with each directory cut from it, so a file name stands where an absolute path was. */
export function plainError(err: unknown, dirs: readonly string[]): string {
  const text = err instanceof Error ? err.message : String(err)
  return dirs.reduce((cut, dir) => cut.replaceAll(`${dir}${path.sep}`, '').replaceAll(dir, '.'), text)
}

type Plain = (err: unknown) => string

/** Throws when events.db cannot be read. */
export function readInbox(dbPath: string, seat: string): InboxReading {
  const db = openEvents(dbPath)
  try {
    const sent = db
      .prepare(
        `SELECT id, ts FROM events WHERE actor = ? AND kind IN (${SENT_KINDS}) ORDER BY id DESC LIMIT 1`,
      )
      .get(seat) as { id: number; ts: number } | undefined
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE target = ? AND kind IN (${INBOX_KINDS}) AND id > ?`)
      .get(seat, sent?.id ?? 0) as { n: number }
    return { unread: row.n, sinceLastSend: sent === undefined ? null : new Date(sent.ts).toISOString() }
  } finally {
    db.close()
  }
}

/** The watchdog's ownership test: the seat's name prefix, or spawned by the seat. */
const ownedBy = (agents: AgentIdentity[], seat: string, prefix: string | undefined): AgentIdentity[] =>
  agents.filter(a => a.spawnedBy === seat || (prefix !== undefined && a.name.startsWith(`${prefix}-`)))

/** In name order: the roster is newest first, which reorders the lists between two ticks. */
const namesOf = (agents: AgentIdentity[]): string[] => agents.map(a => a.name).sort()

const running = (agent: AgentIdentity): boolean => agent.state !== 'exited' && agent.state !== 'retired'

const ROLES = ['implementer', 'reviewer', 'planner'] as const
type Role = (typeof ROLES)[number] | 'other'

/** The first role word in the profile, so a profile holding two counts once. */
const roleOf = (agent: AgentIdentity): Role => ROLES.find(role => agent.profile.includes(role)) ?? 'other'

function agentLoad(agents: AgentIdentity[], role: Role): AgentLoad {
  const active = agents.filter(a => roleOf(a) === role && running(a))
  const detached = namesOf(active.filter(a => a.state === 'detached'))
  return { active: active.length, names: namesOf(active), detached }
}

function roleLoad(agents: AgentIdentity[], role: Role, cap: number): RoleLoad {
  const { active, names, detached } = agentLoad(agents, role)
  return { active, cap, atCap: active >= cap, names, detached }
}

function parkedLoad(agents: AgentIdentity[]): ParkedLoad {
  const exited = agents.filter(a => roleOf(a) === 'implementer' && a.state === 'exited')
  const onDisk = exited.filter(a => a.isolation === 'worktree' && fs.existsSync(a.cwd))
  return { count: exited.length, names: namesOf(exited), treeOnDisk: namesOf(onDisk) }
}

type SeatBudget = ReturnType<typeof seatBudget>

interface SavedMeters {
  run: SpendMeter | undefined
  day: SpendMeter | undefined
  lastGood: AccountReading | undefined
}

/** A saved meter missing a figure is no meter, so the cap it would cover reads as unknown. */
const usable = (meter: SpendMeter | undefined): SpendMeter | undefined =>
  [meter?.since, meter?.last, meter?.spent].every(Number.isFinite) ? meter : undefined

function savedMeters(doc: WatchdogDoc, seat: string, pool: string | undefined, nowMs: number): SavedMeters {
  if (pool === undefined) return { run: usable(doc.seats[seat]?.run), day: undefined, lastGood: undefined }
  const lastGood = lastGoodReading(doc.lastReadings?.[pool], nowMs)
  return { run: usable(doc.seats[seat]?.run), day: usable(doc.pools[pool]), lastGood }
}

/**
 * `gatePool` over the watchdog's saved run and day meters, advanced to this reading as its next pass would.
 * A meter the watchdog never saved stays absent, so `gatePool` stops a cap that needs it as unknown.
 * A run meter past 12 hours counts from its last reading, because this read saves no restart.
 */
function seatGate(
  { pool, spend }: SeatBudget,
  saved: SavedMeters,
  reading: AccountReading | undefined,
  now: Date,
): { gate: PoolGateResult; day: SpendMeter | undefined } {
  const nowMs = now.getTime()
  const advance = (meter: SpendMeter | undefined, current: typeof withinRun): SpendMeter | undefined =>
    meter === undefined ? undefined : advanceMeter(meter, reading?.sevenDay, nowMs, current)
  const run = advance(saved.run, withinRun)
  const day = advance(saved.day, sameSpendDay)
  const runStart = runStartAt(now, saved.run === undefined ? {} : { recordedAt: saved.run.since })
  const starts = [
    { at: runStart, meter: run },
    { at: dayStart(now), meter: day },
  ]
  const history = meterHistory(starts, nowMs)
  const input = {
    pool,
    spend,
    reading,
    lastGood: saved.lastGood,
    history,
    runStartAt: runStart,
    ctx: { now },
  }
  return { gate: gatePool(input), day }
}

type Verdict = Pick<BudgetStatus, 'stop' | 'margin' | 'sonnetOnly' | 'spendSince' | 'note'> & {
  /** CC-409: set when the gate opened on the pool's last good reading. */
  staleOk?: AccountReading
}

const stopped = (stop: string): Verdict => ({
  stop,
  margin: null,
  sonnetOnly: false,
  spendSince: null,
  note: null,
})

/** The watchdog's own wording for a day meter that has no reading at or before 07:00. */
function lateDayStart(day: SpendMeter | undefined, now: Date): Pick<Verdict, 'spendSince' | 'note'> {
  if (day === undefined || day.before !== undefined || day.since <= dayStart(now))
    return { spendSince: null, note: null }
  const since = new Date(day.since).toISOString()
  return {
    spendSince: since,
    note: `no seven_day reading at or before 07:00, so the day's spend counts from the first sample at ${since}`,
  }
}

/** A state file that cannot be read is a stop: the spend the caps count is unknown. */
function spendVerdict(
  deps: StatusDeps,
  budget: SeatBudget,
  seat: string,
  reading: AccountReading | undefined,
  now: Date,
  plain: Plain,
): Verdict {
  const name = budget.pool?.name
  let doc: WatchdogDoc
  try {
    doc = deps.loadDoc()
  } catch (err) {
    return stopped(`BUDGET-PAUSE pool ${name ?? 'unknown'}: ${plain(err)}, so spend is unknown`)
  }
  const saved = savedMeters(doc, seat, name, now.getTime())
  const { gate, day } = seatGate(budget, saved, reading, now)
  if (!gate.open) return { ...stopped(gate.reason), ...lateDayStart(day, now) }
  const staleOk = gate.staleOk === true && saved.lastGood !== undefined ? { staleOk: saved.lastGood } : {}
  return {
    stop: null,
    margin: gate.reason,
    sonnetOnly: gate.sonnetOnly,
    ...lateDayStart(day, now),
    ...staleOk,
  }
}

function budgetStatus(deps: StatusDeps, policy: Policy, seat: string, now: Date, plain: Plain): BudgetStatus {
  const budget = seatBudget(policy.charter, policy.seat)
  const name = budget.pool?.name
  const configDir = name === undefined ? undefined : policy.charter.pools[name]?.config_dir
  const read =
    configDir === undefined ? undefined : deps.readBudget(expandHome(configDir, deps.homeDir), now.getTime())
  const reading = read === undefined ? undefined : accountReading(read, now.getTime())
  const { staleOk, ...verdict } = spendVerdict(deps, budget, seat, reading, now, plain)
  const shown = staleOk ?? reading
  return {
    pool: name ?? null,
    sevenDay: shown?.sevenDay ?? null,
    fiveHour: shown?.fiveHour ?? null,
    ageSeconds: shown?.ageSeconds ?? null,
    stale: staleOk !== undefined || (read?.found === true ? read.stale : true),
    staleOk: staleOk !== undefined,
    ...verdict,
  }
}

/** An events.db that cannot be read costs the status its inbox count, not the other readings. */
function inboxReading(deps: StatusDeps, seat: string, plain: Plain): InboxReading {
  try {
    return deps.inbox(seat)
  } catch (err) {
    return { unread: null, sinceLastSend: null, error: plain(err) }
  }
}

const eligibleTask = (row: DispatchRow): EligibleTask => ({
  id: row.id,
  initiative: row.initiative,
  title: row.title,
  kind: row.kind,
  route: row.route,
  score: row.effective,
  rawScore: row.score,
})

/** A scorer that throws costs the status its eligible list, not the other readings. */
function eligibleStatus(deps: StatusDeps, seat: string, today: string, plain: Plain): EligibleStatus {
  try {
    const plan = deps.scored(seat, today)
    return { top: plan.order.slice(0, STATUS_TOP).map(eligibleTask), skipped: plan.skipped.length, today }
  } catch (err) {
    return { top: [], skipped: 0, today, error: plain(err) }
  }
}

/** Throws for a name the charter does not list as a seat, an unreadable charter or seat file, and a broker that does not answer. */
export async function seatStatus(deps: StatusDeps, seat: string): Promise<SeatStatus> {
  const policy = loadPolicy(deps.autonomyRoot, seat)
  const now = deps.now()
  const { prefix, concurrency } = policy.seat
  const roster = await deps.agents()
  const mine = ownedBy(roster, seat, prefix)
  const plain: Plain = err => plainError(err, [deps.autonomyRoot, deps.homeDir])
  return {
    seat,
    at: now.toISOString(),
    implementers: roleLoad(mine, 'implementer', concurrency.implementers),
    reviewers: roleLoad(mine, 'reviewer', concurrency.reviewers),
    planners: roleLoad(mine, 'planner', concurrency.planners),
    other: agentLoad(mine, 'other'),
    parked: parkedLoad(mine),
    budget: budgetStatus(deps, policy, seat, now, plain),
    inbox: inboxReading(deps, seat, plain),
    eligible: eligibleStatus(deps, seat, localDate(now), plain),
    machine: deps.machine(roster),
  }
}

const LABEL_WIDTH = 13
const TITLE_WIDTH = 60

const line = (label: string, text: string): string => `${label.padEnd(LABEL_WIDTH)} ${text}`

function agentLine(label: string, load: AgentLoad, count: string, flag = ''): string {
  const detached = load.detached.length === 0 ? '' : `detached: ${load.detached.join(', ')}`
  return line(label, [count, flag, load.names.join(', '), detached].filter(Boolean).join('  '))
}

const roleLine = (label: string, load: RoleLoad): string =>
  agentLine(label, load, `${load.active}/${load.cap}`, load.atCap ? 'AT CAP' : '')

/** The pool's reading in words, shared with the boot page. */
export function poolReadingText(budget: BudgetStatus): string {
  const pool = `pool ${budget.pool ?? 'unknown'}`
  if (budget.ageSeconds === null) return `${pool}: no reading`
  const flag = budget.staleOk ? ', STALE-OK' : budget.stale ? ', STALE' : ''
  const age = `${budget.staleOk ? 'last good reading' : 'reading'} ${budget.ageSeconds}s old${flag}`
  return `${pool}: seven_day ${budget.sevenDay ?? '?'}%, five_hour ${budget.fiveHour ?? '?'}% (${age})`
}

const budgetLine = (budget: BudgetStatus): string => line('budget', poolReadingText(budget))

function eligibleLines(eligible: EligibleStatus): string[] {
  if (eligible.error !== undefined) return [line('eligible', `unavailable: ${eligible.error}`)]
  const skipped = eligible.skipped === 0 ? [] : [`${eligible.skipped} malformed task(s) skipped`]
  const rows = eligible.top.map(
    task => `${task.id}  ${task.score.toFixed(1)}  ${task.initiative}  ${task.title.slice(0, TITLE_WIDTH)}`,
  )
  const texts = rows.length === 0 ? ['none', ...skipped] : [...rows, ...skipped]
  return texts.map((text, i) => line(i === 0 ? 'eligible' : '', text))
}

const unread = (what: string, error: string | undefined): string =>
  `${what} unread${error === undefined ? '' : ` (${error})`}`

function machineLine({ headlessAgents, memoryFree, swap, fullSuiteSlots }: MachineStatus): string {
  const atCap = headlessAgents.live >= headlessAgents.limit ? ' AT CAP' : ''
  const memory =
    memoryFree.percent === null
      ? unread('memory', memoryFree.error)
      : `memory ${memoryFree.percent}% free/${memoryFree.limit}% floor${memoryFree.percent < memoryFree.limit ? ' LOW' : ''}`
  const swapText = swap.usedPercent === null ? unread('swap', swap.error) : `swap ${swap.usedPercent}% used`
  const parts = [
    `headless ${headlessAgents.live}/${headlessAgents.limit}${atCap}`,
    memory,
    swapText,
    `suite slots ${fullSuiteSlots.inUse}/${fullSuiteSlots.total}`,
  ]
  return line('machine', parts.join(', '))
}

function inboxLine(inbox: InboxReading): string {
  if (inbox.error !== undefined) return line('inbox', `unavailable: ${inbox.error}`)
  const since =
    inbox.sinceLastSend === null
      ? 'the seat has sent nothing'
      : `since its last send at ${inbox.sinceLastSend}`
  return line('inbox', `${inbox.unread} unread (${since})`)
}

export function renderStatus(status: SeatStatus): string[] {
  const { parked, budget } = status
  const trees = parked.treeOnDisk.length === 0 ? '' : `  tree on disk: ${parked.treeOnDisk.join(', ')}`
  return [
    `seat ${status.seat} at ${status.at}`,
    roleLine('implementers', status.implementers),
    roleLine('reviewers', status.reviewers),
    roleLine('planners', status.planners),
    agentLine('other', status.other, String(status.other.active)),
    line('parked', `${parked.count}${trees}`),
    budgetLine(budget),
    line('stop', budget.stop ?? `none; ${budget.margin}`),
    ...(budget.note === null ? [] : [line('note', budget.note)]),
    machineLine(status.machine),
    inboxLine(status.inbox),
    ...eligibleLines(status.eligible),
  ]
}
