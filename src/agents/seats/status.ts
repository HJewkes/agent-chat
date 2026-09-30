import fs from 'node:fs'
import os from 'node:os'
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
import { accountReading } from './watchdog.js'

/**
 * CC-317: what a coordinator seat reads before it dispatches, in one call.
 * Read-only: the spend meters are advanced in memory and never saved.
 */

/** How many of the scorer's rows a tick looks at. */
export const STATUS_TOP = 3

export interface RoleLoad {
  active: number
  cap: number
  atCap: boolean
  names: string[]
  /** Those of `names` with no connected session; they count as active because the process may still be running. */
  detached: string[]
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
  /** The charter stop that closes the seat's gate, or null when it is open. */
  stop: string | null
  /** The open gate's figures against its lines. */
  margin: string | null
  sonnetOnly: boolean
}

export interface InboxReading {
  /** Messages to the seat since its own last send; the broker keeps no read cursor. */
  unread: number
  sinceLastSend: string | null
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
  parked: ParkedLoad
  budget: BudgetStatus
  inbox: InboxReading
  eligible: EligibleStatus
}

export interface StatusDeps {
  now: () => Date
  autonomyRoot: string
  /** The broker's roster without retired agents. */
  agents: () => Promise<AgentIdentity[]>
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  loadDoc: () => WatchdogDoc
  inbox: (seat: string) => InboxReading
  scored: (seat: string, today: string) => ScoredPlan
}

const INBOX_KINDS = "'message', 'broadcast', 'answer', 'decided'"
const SENT_KINDS = "'message', 'broadcast', 'question', 'notice'"

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

function roleLoad(agents: AgentIdentity[], role: string, cap: number): RoleLoad {
  const active = agents.filter(a => a.profile.includes(role) && running(a))
  const detached = namesOf(active.filter(a => a.state === 'detached'))
  return { active: active.length, cap, atCap: active.length >= cap, names: namesOf(active), detached }
}

function parkedLoad(agents: AgentIdentity[]): ParkedLoad {
  const exited = agents.filter(a => a.profile.includes('implementer') && a.state === 'exited')
  const onDisk = exited.filter(a => a.isolation === 'worktree' && fs.existsSync(a.cwd))
  return { count: exited.length, names: namesOf(exited), treeOnDisk: namesOf(onDisk) }
}

type SeatBudget = ReturnType<typeof seatBudget>

/** `gatePool` over the watchdog's saved run and day meters, advanced to this reading as its next pass would. */
function seatGate(
  { pool, spend }: SeatBudget,
  saved: { run: SpendMeter | undefined; day: SpendMeter | undefined },
  reading: AccountReading | undefined,
  now: Date,
): PoolGateResult {
  const nowMs = now.getTime()
  const run = advanceMeter(saved.run, reading?.sevenDay, nowMs, withinRun)
  const day = advanceMeter(saved.day, reading?.sevenDay, nowMs, sameSpendDay)
  const runStart = runStartAt(now, run === undefined ? {} : { recordedAt: run.since })
  const starts = [
    { at: runStart, meter: run },
    { at: dayStart(now), meter: day },
  ]
  const history = meterHistory(starts, nowMs)
  return gatePool({ pool, spend, reading, history, runStartAt: runStart, ctx: { now } })
}

function budgetStatus(deps: StatusDeps, policy: Policy, seat: string, now: Date): BudgetStatus {
  const budget = seatBudget(policy.charter, policy.seat)
  const name = budget.pool?.name
  const configDir = name === undefined ? undefined : policy.charter.pools[name]?.config_dir
  const read =
    configDir === undefined ? undefined : deps.readBudget(expandHome(configDir, os.homedir()), now.getTime())
  const reading = read === undefined ? undefined : accountReading(read, now.getTime())
  const doc = deps.loadDoc()
  const saved = { run: doc.seats[seat]?.run, day: name === undefined ? undefined : doc.pools[name] }
  const gate = seatGate(budget, saved, reading, now)
  return {
    pool: name ?? null,
    sevenDay: reading?.sevenDay ?? null,
    fiveHour: reading?.fiveHour ?? null,
    ageSeconds: reading?.ageSeconds ?? null,
    stale: read?.found === true ? read.stale : true,
    stop: gate.open ? null : gate.reason,
    margin: gate.open ? gate.reason : null,
    sonnetOnly: gate.open && gate.sonnetOnly,
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
function eligibleStatus(deps: StatusDeps, seat: string, today: string): EligibleStatus {
  try {
    const plan = deps.scored(seat, today)
    return { top: plan.order.slice(0, STATUS_TOP).map(eligibleTask), skipped: plan.skipped.length, today }
  } catch (err) {
    return { top: [], skipped: 0, today, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Throws for a name the charter does not list as a seat. */
export async function seatStatus(deps: StatusDeps, seat: string): Promise<SeatStatus> {
  const policy = loadPolicy(deps.autonomyRoot, seat)
  const now = deps.now()
  const { prefix, concurrency } = policy.seat
  const mine = ownedBy(await deps.agents(), seat, prefix)
  return {
    seat,
    at: now.toISOString(),
    implementers: roleLoad(mine, 'implementer', concurrency.implementers),
    reviewers: roleLoad(mine, 'reviewer', concurrency.reviewers),
    planners: roleLoad(mine, 'planner', concurrency.planners),
    parked: parkedLoad(mine),
    budget: budgetStatus(deps, policy, seat, now),
    inbox: deps.inbox(seat),
    eligible: eligibleStatus(deps, seat, localDate(now)),
  }
}

const LABEL_WIDTH = 13
const TITLE_WIDTH = 60

const line = (label: string, text: string): string => `${label.padEnd(LABEL_WIDTH)} ${text}`

function roleLine(label: string, load: RoleLoad): string {
  const detached = load.detached.length === 0 ? '' : `detached: ${load.detached.join(', ')}`
  const parts = [`${load.active}/${load.cap}`, load.atCap ? 'AT CAP' : '', load.names.join(', '), detached]
  return line(label, parts.filter(Boolean).join('  '))
}

function budgetLine(budget: BudgetStatus): string {
  if (budget.ageSeconds === null) return line('budget', `pool ${budget.pool ?? 'unknown'}: no reading`)
  const age = `reading ${budget.ageSeconds}s old${budget.stale ? ', STALE' : ''}`
  return line(
    'budget',
    `pool ${budget.pool ?? 'unknown'}: seven_day ${budget.sevenDay ?? '?'}%, five_hour ${budget.fiveHour ?? '?'}% (${age})`,
  )
}

function eligibleLines(eligible: EligibleStatus): string[] {
  if (eligible.error !== undefined) return [line('eligible', `unavailable: ${eligible.error}`)]
  const skipped = eligible.skipped === 0 ? [] : [`${eligible.skipped} malformed task(s) skipped`]
  const rows = eligible.top.map(
    task => `${task.id}  ${task.score.toFixed(1)}  ${task.initiative}  ${task.title.slice(0, TITLE_WIDTH)}`,
  )
  const texts = rows.length === 0 ? ['none', ...skipped] : [...rows, ...skipped]
  return texts.map((text, i) => line(i === 0 ? 'eligible' : '', text))
}

export function renderStatus(status: SeatStatus): string[] {
  const { parked, inbox } = status
  const trees = parked.treeOnDisk.length === 0 ? '' : `  tree on disk: ${parked.treeOnDisk.join(', ')}`
  const since =
    inbox.sinceLastSend === null
      ? 'the seat has sent nothing'
      : `since its last send at ${inbox.sinceLastSend}`
  return [
    `seat ${status.seat} at ${status.at}`,
    roleLine('implementers', status.implementers),
    roleLine('reviewers', status.reviewers),
    roleLine('planners', status.planners),
    line('parked', `${parked.count}${trees}`),
    budgetLine(status.budget),
    line('stop', status.budget.stop ?? `none; ${status.budget.margin}`),
    line('inbox', `${inbox.unread} unread (${since})`),
    ...eligibleLines(status.eligible),
  ]
}
