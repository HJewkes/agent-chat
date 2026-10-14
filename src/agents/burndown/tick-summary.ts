import fs from 'node:fs'
import path from 'node:path'
import { claimKey, type ClaimKey } from './advance.js'
import { briefRefusal, type Task } from './eligibility.js'
import type { RegisterReply, Registration } from './shepherd.js'
import type { Ledger } from './ledger.js'
import { orphanQueues, type OrphanQueue } from './orphan-queue.js'
import { firstRefusalPerTask, refusalTally, type SeatOutcome } from './no-dispatch.js'
import type { Dispatch } from './plan.js'
import { bindingOf, type Binding } from './gate-reading.js'
import { onPlan } from './seat-scope.js'
import type { AdoptSeat } from './pr-adopt.js'
import type { SeatDispatch } from './seat-dispatch.js'
import type { Step } from './execute.js'
import type { TickStep } from './step-timer.js'

/**
 * CC-929 (item 179 S5): every real tick that runs appends one row to `burndown-ticks.jsonl`, built from what the
 * tick already holds. `burndown dispatch-stats` (S9) reads it. One JSON object per line; a reader skips a row
 * whose `v` it does not know. Schema `v: 1`:
 *
 *   v               1
 *   ts              the tick's time, ISO 8601
 *   registrations   {ok, refused, failed}: every Shepherd register the tick made, for its claims and for the
 *                   seat PRs it adopted (CC-861), seat or not
 *   seats           {[seat]: SeatSummary}, one per configured seat; empty outside seats mode
 *   durationMs      CC-1192: the whole tick, monotonic ms
 *   lockHeldMs      CC-1192: from taking the ledger lock to releasing it: every step but `config`, and the untimed
 *                   work between steps
 *   orphanQueues    CC-1226: [{seat, queued, ready, oldestMinutes}] for each seat that holds queued claims but
 *                   has no plan this tick; absent when there is none or the tick did not pass its ledger
 *   steps           CC-1192: [{name, ms}] per named stage in run order (`StepName` in step-timer.ts); `plan` holds
 *                   the planning on both sides of `collision`; factory
 *                   graph: T2 roster/world/seats/observe/decider/collision, T4/T5 plan, T6 execute/adopt/
 *                   decider-triage, T7 write-ledger and this row's write
 *   serviceCheck    CC-1127: {cause, stopped, message} of the tick's one service-check read: cause null when the
 *                   check passed, stopped true when this read and the previous one stopped the line, message on
 *                   one line of at most 200 chars; seats mode only
 *
 * Rows from before CC-1192 lack durationMs, lockHeldMs and steps; rows from before CC-1127 lack serviceCheck.
 *
 * SeatSummary:
 *   ready           tasks the seat's plan considered (dispatched or refused) with a fresh brief:ready tag; a ready
 *                   task the plan never reached (scorer-excluded or blocked) is not counted, so this is not a
 *                   full count of the seat's ready tasks
 *   unbriefed       considered tasks with no valid brief:ready tag
 *   stale           considered tasks whose brief:ready is older than briefMaxAgeDays
 *   dispatched      dispatches the plan made
 *   refusals        {[refusal kind]: count}: CC-1186: each refused (initiative, task) once, under the kind of its
 *                   first refusal, and each refusal that names no task once. Rows from before CC-1186 counted a
 *                   task once per refusal, so a task with refused slices counted again for its own row
 *   onPlanRefusals  CC-1128: {[refusal kind]: count} of the refused tasks, counted as in `refusals`, that the seat's
 *                   plan_file section 2 names, by id or by a dep:/parent:/delivered-by:/blocked-by: tag; absent
 *                   when the seat has no readable plan_file
 *   trust           CC-1077: [{initiative, task?, reason}] for each distinct trust refusal, reason on one line of at
 *                   most 200 chars, at most 10 entries (the exact count of tasks first refused on trust stays in
 *                   `refusals.trust`); absent when the seat refused nothing on trust
 *   roles           {used, cap}, each {implementers, reviewers, planners}; `used` is what the seat's role caps
 *                   counted after planning: held claims, live hand spawns and this tick's dispatches; absent when
 *                   the seat was not planned
 *   registrations   {ok, refused, failed} for the seat's claims and its adopted PRs
 *   binding         CC-1097: {kind, initiative, task?, lever, value, reading, headroom, source} of the first refusal,
 *                   in rank order, that a capacity lever made (role-cap, worktrees, slots, budget): the lever that
 *                   bound the seat this tick; null when no capacity lever refused; absent when the seat was skipped.
 *                   Rows from before CC-1097 lack it
 *   skipped         why the seat was not planned; absent when it was
 */

export const TICK_SUMMARY_VERSION = 1

type Roles = SeatDispatch['caps']
export type RegisterOutcome = 'ok' | 'refused' | 'failed'
export type RegisterCounts = Record<RegisterOutcome, number>

export interface SeatSummary {
  ready: number
  unbriefed: number
  stale: number
  dispatched: number
  refusals: Record<string, number>
  onPlanRefusals?: Record<string, number>
  trust?: NamedRefusal[]
  roles?: { used: Roles; cap: Roles }
  registrations: RegisterCounts
  binding?: Binding | null
  skipped?: string
}

export interface NamedRefusal {
  initiative: string
  task?: string
  reason: string
}

/** CC-1127: the tick's service-check read, so a stop's cause is in the row rather than only in burndown.log. */
export interface ServiceCheckSummary {
  /** Null when the check passed. */
  cause: string | null
  /** The line stopped this tick: this read and the previous one both stopped. */
  stopped: boolean
  message: string
}

export interface TickSummaryRow {
  v: typeof TICK_SUMMARY_VERSION
  ts: string
  registrations: RegisterCounts
  seats: Record<string, SeatSummary>
  durationMs?: number
  lockHeldMs?: number
  steps?: TickStep[]
  orphanQueues?: OrphanQueue[]
  serviceCheck?: ServiceCheckSummary
}

export type TickTimings = Required<Pick<TickSummaryRow, 'durationMs' | 'lockHeldMs' | 'steps'>>

export interface RegisterRecord {
  seat?: string
  outcome: RegisterOutcome
}

/** What `decide` already holds for the row; the tick adds its registrations. */
export interface SummaryPlan {
  maxAgeDays: number
  caps: Record<string, Roles>
  outcomes: readonly SeatOutcome[]
  dispatch: readonly Dispatch[]
  tasks: ReadonlyMap<string, readonly Task[]>
  /** Seats mode only: the tick's service-check read. */
  serviceCheck?: ServiceCheckSummary
}

export interface SummaryInputs extends SummaryPlan {
  now: Date
  registrations: readonly RegisterRecord[]
  /** CC-1226: the ledger the tick planned against; without it the row names no orphan queue. */
  ledger?: Ledger
}

const noRegistrations = (): RegisterCounts => ({ ok: 0, refused: 0, failed: 0 })

function countRegistrations(records: readonly RegisterRecord[]): RegisterCounts {
  const counts = noRegistrations()
  for (const r of records) counts[r.outcome] += 1
  return counts
}

/** Each task the seat's plan dispatched or refused, once, classified by its brief:ready tag. */
function briefCounts(
  inputs: SummaryInputs,
  outcome: SeatOutcome,
): Pick<SeatSummary, 'ready' | 'unbriefed' | 'stale'> {
  const considered = new Map<string, Task>()
  const consider = (initiative: string, id: string | undefined): void => {
    const task = inputs.tasks.get(initiative)?.find(t => t.id === id)
    if (task !== undefined) considered.set(`${initiative}/${task.id}`, task)
  }
  for (const d of inputs.dispatch) if (d.seat === outcome.seat) consider(d.initiative, d.task)
  for (const r of outcome.refusals) consider(r.initiative, r.task)
  const counts = { ready: 0, unbriefed: 0, stale: 0 }
  for (const task of considered.values()) {
    const refused = briefRefusal(task, { maxAgeDays: inputs.maxAgeDays, now: inputs.now })
    if (refused === undefined) counts.ready += 1
    else if (refused.kind === 'brief-stale') counts.stale += 1
    else counts.unbriefed += 1
  }
  return counts
}

const MAX_REASON_CHARS = 200
const MAX_NAMED_TRUST = 10

const oneLine = (reason: string): string => reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS)

/** CC-1077: the trust refusals by task and reason, so a tick row says which task the gate refused and why. */
function namedTrustRefusals(outcome: SeatOutcome): NamedRefusal[] {
  const named = new Map<string, NamedRefusal>()
  for (const r of outcome.refusals) {
    if (r.kind !== 'trust') continue
    const entry: NamedRefusal = {
      initiative: r.initiative,
      ...(r.task === undefined ? {} : { task: r.task }),
      reason: oneLine(r.reason),
    }
    named.set(JSON.stringify([entry.initiative, entry.task, entry.reason]), entry)
  }
  return [...named.values()].slice(0, MAX_NAMED_TRUST)
}

/** CC-1128: on-plan refused tasks by their first refusal's kind; a task not in the inputs is matched by its id alone. */
function onPlanRefusals(inputs: SummaryInputs, outcome: SeatOutcome): Record<string, number> | undefined {
  const plan = outcome.plan
  if (plan === undefined) return undefined
  const counts: Record<string, number> = {}
  for (const r of firstRefusalPerTask(outcome.refusals)) {
    if (r.task === undefined) continue
    const task = inputs.tasks.get(r.initiative)?.find(t => t.id === r.task) ?? { id: r.task, tags: [] }
    if (onPlan(plan, task)) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  }
  return counts
}

function seatSummary(inputs: SummaryInputs, outcome: SeatOutcome): SeatSummary {
  const refusals = Object.fromEntries(refusalTally(outcome.refusals))
  const cap = inputs.caps[outcome.seat]
  const used = outcome.roles
  const trust = namedTrustRefusals(outcome)
  const onPlanCounts = onPlanRefusals(inputs, outcome)
  return {
    ...briefCounts(inputs, outcome),
    dispatched: outcome.dispatched,
    refusals,
    ...(onPlanCounts === undefined ? {} : { onPlanRefusals: onPlanCounts }),
    ...(trust.length === 0 ? {} : { trust }),
    ...(cap === undefined || used === undefined ? {} : { roles: { used, cap } }),
    registrations: countRegistrations(inputs.registrations.filter(r => r.seat === outcome.seat)),
    ...(outcome.skipped === undefined
      ? { binding: bindingOf(outcome.refusals) }
      : { skipped: outcome.skipped }),
  }
}

/** CC-1226: the seats that hold queued claims although no plan covered them this tick. */
function orphansOf(inputs: SummaryInputs): OrphanQueue[] {
  if (inputs.ledger === undefined) return []
  const planned = new Set(inputs.outcomes.filter(o => o.skipped === undefined).map(o => o.seat))
  return orphanQueues(inputs.ledger, planned, inputs.now)
}

export function tickSummary(inputs: SummaryInputs, timings?: TickTimings): TickSummaryRow {
  const orphans = orphansOf(inputs)
  return {
    v: TICK_SUMMARY_VERSION,
    ts: inputs.now.toISOString(),
    registrations: countRegistrations(inputs.registrations),
    seats: Object.fromEntries(inputs.outcomes.map(o => [o.seat, seatSummary(inputs, o)])),
    ...(orphans.length === 0 ? {} : { orphanQueues: orphans }),
    ...(inputs.serviceCheck === undefined
      ? {}
      : { serviceCheck: { ...inputs.serviceCheck, message: oneLine(inputs.serviceCheck.message) } }),
    ...timings,
  }
}

const outcomeOf = (reply: RegisterReply): RegisterOutcome =>
  reply.ok ? 'ok' : reply.refused ? 'refused' : 'failed'

type Register = (registration: Registration) => RegisterReply
type SeatOf = (registration: Registration) => string | undefined

/** The one wrapper every Shepherd register the tick makes goes through, so no path is left out of the row. */
export function recordingRegister(register: Register, seatOf: SeatOf, into: RegisterRecord[]): Register {
  return registration => {
    const reply = register(registration)
    const seat = seatOf(registration)
    into.push({ outcome: outcomeOf(reply), ...(seat === undefined ? {} : { seat }) })
    return reply
  }
}

/** A claim-path registration's seat: the seat of the claim its register step was for. */
export function claimSeatOf(steps: readonly Step[], ledger: Ledger): SeatOf {
  const keys = new Map<Registration, ClaimKey>(
    steps.flatMap(s => (s.kind === 'register' ? [[s.registration, s.key] as const] : [])),
  )
  return registration => {
    const key = keys.get(registration)
    if (key === undefined) return undefined
    return ledger.claims.find(c => c.phase !== 'done' && claimKey(c) === claimKey(key))?.seat
  }
}

/** An adopted PR's seat: the one whose `<prefix>-` starts the implementer, which adoption takes from the branch. */
export function adoptSeatOfRegistration(seats: readonly AdoptSeat[]): SeatOf {
  const longestFirst = [...seats].sort((a, b) => b.prefix.length - a.prefix.length)
  return registration => longestFirst.find(s => registration.implementer.startsWith(`${s.prefix}-`))?.seat
}

export type SummaryLog = (event: string, detail: Record<string, unknown>) => void

/** An appender whose first failed write is logged and every later one is silent; it never throws. */
export function tickSummaryWriter(file: () => string): (row: TickSummaryRow, log: SummaryLog) => void {
  let warned = false
  return (row, log) => {
    try {
      const target = file()
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.appendFileSync(target, `${JSON.stringify(row)}\n`)
    } catch (err) {
      if (warned) return
      warned = true
      log('burndown_tick_summary_failed', { reason: err instanceof Error ? err.message : String(err) })
    }
  }
}
