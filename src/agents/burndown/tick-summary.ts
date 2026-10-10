import fs from 'node:fs'
import path from 'node:path'
import { claimKey, type ClaimKey } from './advance.js'
import { briefRefusal, type Task } from './eligibility.js'
import type { RegisterReply, Registration } from './shepherd.js'
import type { Claim, Ledger } from './ledger.js'
import type { SeatOutcome } from './no-dispatch.js'
import type { Dispatch } from './plan.js'
import type { SeatDispatch } from './seat-dispatch.js'
import type { Step } from './execute.js'

/**
 * CC-929 (item 179 S5): every real tick that runs appends one row to `burndown-ticks.jsonl`, built from what the
 * tick already holds. `burndown dispatch-stats` (S9) reads it. One JSON object per line; a reader skips a row
 * whose `v` it does not know. Schema `v: 1`:
 *
 *   v               1
 *   ts              the tick's time, ISO 8601
 *   registrations   {ok, refused, failed}: every Shepherd register the tick made, seat or not
 *   seats           {[seat]: SeatSummary}, one per configured seat; empty outside seats mode
 *
 * SeatSummary:
 *   ready           tasks the seat's plan considered (dispatched or refused) with a fresh brief:ready tag
 *   unbriefed       considered tasks with no valid brief:ready tag
 *   stale           considered tasks whose brief:ready is older than briefMaxAgeDays
 *   dispatched      dispatches the plan made
 *   refusals        {[refusal kind]: count}
 *   roles           {used, cap}, each {implementers, reviewers, planners}; `used` counts the seat's held claims in
 *                   the ledger the tick writes, so hand-spawned agents are not in it; absent for a skipped seat
 *   registrations   {ok, refused, failed} for the seat's claims
 *   skipped         why the seat was not planned; absent when it was
 */

export const TICK_SUMMARY_VERSION = 1

type Roles = SeatDispatch['caps']
type Role = keyof Roles
export type RegisterOutcome = 'ok' | 'refused' | 'failed'
export type RegisterCounts = Record<RegisterOutcome, number>

export interface SeatSummary {
  ready: number
  unbriefed: number
  stale: number
  dispatched: number
  refusals: Record<string, number>
  roles?: { used: Roles; cap: Roles }
  registrations: RegisterCounts
  skipped?: string
}

export interface TickSummaryRow {
  v: typeof TICK_SUMMARY_VERSION
  ts: string
  registrations: RegisterCounts
  seats: Record<string, SeatSummary>
}

export interface RegisterRecord {
  seat?: string
  outcome: RegisterOutcome
}

/** What `decide` already holds for the row; the tick adds its written ledger and its registrations. */
export interface SummaryPlan {
  maxAgeDays: number
  caps: Record<string, Roles>
  outcomes: readonly SeatOutcome[]
  dispatch: readonly Dispatch[]
  tasks: ReadonlyMap<string, readonly Task[]>
}

export interface SummaryInputs extends SummaryPlan {
  now: Date
  ledger: Ledger
  registrations: readonly RegisterRecord[]
}

const ROLE_OF_PHASE: Partial<Record<Claim['phase'], Role>> = {
  planning: 'planners',
  implementing: 'implementers',
  reviewing: 'reviewers',
}

const noRegistrations = (): RegisterCounts => ({ ok: 0, refused: 0, failed: 0 })

function countRegistrations(records: readonly RegisterRecord[]): RegisterCounts {
  const counts = noRegistrations()
  for (const r of records) counts[r.outcome] += 1
  return counts
}

function rolesUsed(ledger: Ledger, seat: string): Roles {
  const used: Roles = { implementers: 0, reviewers: 0, planners: 0 }
  for (const c of ledger.claims) {
    if (c.seat !== seat || c.phase === 'done') continue
    const role = ROLE_OF_PHASE[c.phase === 'spawning' ? (c.nextPhase ?? 'spawning') : c.phase]
    if (role !== undefined) used[role] += 1
  }
  return used
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

function seatSummary(inputs: SummaryInputs, outcome: SeatOutcome): SeatSummary {
  const refusals: Record<string, number> = {}
  for (const r of outcome.refusals) refusals[r.kind] = (refusals[r.kind] ?? 0) + 1
  const cap = inputs.caps[outcome.seat]
  return {
    ...briefCounts(inputs, outcome),
    dispatched: outcome.dispatched,
    refusals,
    ...(cap === undefined ? {} : { roles: { used: rolesUsed(inputs.ledger, outcome.seat), cap } }),
    registrations: countRegistrations(inputs.registrations.filter(r => r.seat === outcome.seat)),
    ...(outcome.skipped === undefined ? {} : { skipped: outcome.skipped }),
  }
}

export function tickSummary(inputs: SummaryInputs): TickSummaryRow {
  return {
    v: TICK_SUMMARY_VERSION,
    ts: inputs.now.toISOString(),
    registrations: countRegistrations(inputs.registrations),
    seats: Object.fromEntries(inputs.outcomes.map(o => [o.seat, seatSummary(inputs, o)])),
  }
}

const outcomeOf = (reply: RegisterReply): RegisterOutcome =>
  reply.ok ? 'ok' : reply.refused ? 'refused' : 'failed'

/** Registers through `register` and records each reply against the seat of the claim its step was for. */
export function recordingRegister(
  steps: readonly Step[],
  ledger: Ledger,
  register: (registration: Registration) => RegisterReply,
  into: RegisterRecord[],
): (registration: Registration) => RegisterReply {
  const keys = new Map<Registration, ClaimKey>(
    steps.flatMap(s => (s.kind === 'register' ? [[s.registration, s.key] as const] : [])),
  )
  const seatOf = (key: ClaimKey | undefined): string | undefined =>
    key === undefined
      ? undefined
      : ledger.claims.find(c => c.phase !== 'done' && claimKey(c) === claimKey(key))?.seat
  return registration => {
    const reply = register(registration)
    const seat = seatOf(keys.get(registration))
    into.push({ outcome: outcomeOf(reply), ...(seat === undefined ? {} : { seat }) })
    return reply
  }
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
