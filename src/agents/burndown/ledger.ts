import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * The burndown claim ledger: which task each tick-spawned agent holds.
 *
 * A claim holds its task until its phase is `done`, and a lane only while an
 * agent works on it. A stalled claim (a `stalledReason`, or past its phase
 * timeout) keeps both: the design files it to the backlog rather than
 * respawning it. Moves onto the lifecycle ledger once that is read from
 * (CC-118, CC-102).
 */

export const PHASES = [
  'queued',
  'spawning',
  'planning',
  'implementing',
  'parked',
  'reviewing',
  'awaiting-merge',
  'done',
] as const
export type Phase = (typeof PHASES)[number]

/** Phases a spawn lands in once its agent row appears. */
export const AGENT_PHASES = ['planning', 'implementing', 'reviewing'] as const
export type AgentPhase = (typeof AGENT_PHASES)[number]

const Claim = z.object({
  taskId: z.string(),
  initiative: z.string(),
  /** Set once the broker's roster shows the spawned agent; absent while `spawning`. */
  agentId: z.string().optional(),
  spawnedAt: z.string(),
  phase: z.enum(PHASES),
  /** When the claim entered its current phase; the timeout runs from here. */
  phaseAt: z.string(),
  /** A planner's slice letter; a task holds one claim per slice. */
  slice: z.string().optional(),
  /** Slices of the same task that must reach `done` first. */
  dependsOn: z.array(z.string()).optional(),
  /** The paths a planner's slice declares it touches; the collision check compares them to open PRs and file claims. */
  owns: z.array(z.string()).optional(),
  /** The agent the claim is waiting on now. */
  agentName: z.string().optional(),
  /** Every agent spawned for this claim, oldest first; retired newest first. */
  spawned: z.array(z.string()).optional(),
  /** Where a `spawning` claim goes once its agent row appears. */
  nextPhase: z.enum(AGENT_PHASES).optional(),
  worktree: z.string().optional(),
  questionId: z.string().optional(),
  inboxCursor: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  reviewRound: z.number().int().nonnegative().optional(),
  pr: z.string().optional(),
  lastReport: z.string().optional(),
  stalledReason: z.string().optional(),
  /** Agents whose retire refused after the claim finished, in retire order; each tick retries them (CC-182). */
  unretired: z
    .array(
      z.object({
        name: z.string(),
        reason: z.string(),
        /** When it refused; a row with this name spawned later is a different agent (CC-185). Absent before CC-185. */
        at: z.string().optional(),
      }),
    )
    .optional(),
  /** The seat that dispatched the claim (CC-205); absent for a claim from an initiative's autonomy block. */
  seat: z.string().optional(),
  /** Prefix of every agent name the claim spawns; absent means `bd`. */
  namePrefix: z.string().optional(),
  /** Event kinds already delivered to the claim's seat, so a delivered event is never re-sent. */
  notified: z.array(z.string()).optional(),
  /** The claim's PR as the last leak check found it: redacted `file:line category` rows, never matched text (CC-269). */
  leak: z.object({ url: z.string(), findings: z.array(z.string()) }).optional(),
})
export type Claim = z.infer<typeof Claim>

const DeciderState = z.object({
  /** Every wake the tick sent, oldest first, pruned to the last day; the rate caps count these. */
  wakes: z.array(z.string()),
  /** Why the last wake was refused; cleared by the next wake the broker accepts. */
  refused: z.object({ reason: z.string(), at: z.string() }).optional(),
})
export type DeciderState = z.infer<typeof DeciderState>

/** Matches `SevenDaySample` in budget-gate.ts; the seat's pool gate reads these as its history. */
const SeatSample = z.object({
  at: z.number(),
  sevenDay: z.number(),
  resetsAt: z.number().optional(),
})

const SeatState = z.object({ samples: z.array(SeatSample) })
export type SeatState = z.infer<typeof SeatState>

const Ledger = z.object({
  version: z.literal(1),
  lastTickAt: z.string().optional(),
  claims: z.array(Claim),
  decider: DeciderState.optional(),
  /** Per-seat pool samples, keyed by seat name (CC-205). */
  seats: z.record(z.string(), SeatState).optional(),
  /** Keys of human-queue items the tick filed, so a finding that still holds is filed once (CC-269). */
  humanFiled: z.array(z.string()).optional(),
  /** The deny-list state the leak check last recorded, so a missing list is logged once rather than every tick. */
  leakDenylist: z.string().optional(),
})
export type Ledger = z.infer<typeof Ledger>

export const EMPTY_LEDGER: Ledger = { version: 1, claims: [] }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
export const PHASE_TIMEOUT_MS: Partial<Record<Phase, number>> = {
  spawning: 10 * MINUTE_MS,
  planning: 2 * HOUR_MS,
  implementing: 4 * HOUR_MS,
  reviewing: 2 * HOUR_MS,
}

/** A missing file is an empty ledger; a malformed one throws, because guessing would double-dispatch. */
export function readLedger(file: string): Ledger {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return EMPTY_LEDGER
  }
  let parsed: ReturnType<typeof Ledger.safeParse> | undefined
  try {
    parsed = Ledger.safeParse(JSON.parse(raw))
  } catch {
    parsed = undefined
  }
  if (parsed?.success !== true) throw new Error(`burndown ledger ${file} is malformed`)
  return parsed.data
}

/** Write-then-rename in the same directory, so a reader never sees half a ledger. */
export function writeLedger(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export const heldClaims = (ledger: Ledger): Claim[] => ledger.claims.filter(c => c.phase !== 'done')

const LANE_PHASES: ReadonlySet<Phase> = new Set(['spawning', 'planning', 'implementing', 'reviewing'])

/** Claims with an agent at work: parked, queued and awaiting-merge claims hold their task but not a lane. */
export const laneClaims = (ledger: Ledger): Claim[] => ledger.claims.filter(c => LANE_PHASES.has(c.phase))

export function isStalled(claim: Claim, now: Date): boolean {
  if (claim.stalledReason !== undefined) return true
  const timeout = PHASE_TIMEOUT_MS[claim.phase]
  return timeout !== undefined && now.getTime() - Date.parse(claim.phaseAt) > timeout
}

export const sameClaim = (a: Pick<Claim, 'taskId' | 'slice'>, b: Pick<Claim, 'taskId' | 'slice'>): boolean =>
  a.taskId === b.taskId && a.slice === b.slice

/** A second claim on a held `(task, slice)` is refused rather than merged. */
export function addClaim(ledger: Ledger, claim: Claim): Ledger {
  if (heldClaims(ledger).some(c => sameClaim(c, claim)))
    throw new Error(
      `task ${claim.taskId}${claim.slice === undefined ? '' : ` slice ${claim.slice}`} is already claimed`,
    )
  return { ...ledger, claims: [...ledger.claims, claim] }
}

/** Queued slices whose dependencies are all done, in ledger order. */
export function readySlices(ledger: Ledger): Claim[] {
  const done = (taskId: string, slice: string): boolean =>
    ledger.claims.some(c => c.taskId === taskId && c.slice === slice && c.phase === 'done')
  return ledger.claims.filter(
    c => c.phase === 'queued' && (c.dependsOn ?? []).every(dep => done(c.taskId, dep)),
  )
}

export type LockResult<T> = { ran: true; value: T } | { ran: false; holder: number }

/**
 * Runs `fn` while holding `<file>.lock`, which carries the holder's pid. A
 * lock whose pid is dead is taken over; a live one means another tick is
 * running, so `fn` does not run.
 */
export async function withLedgerLock<T>(file: string, fn: () => T | Promise<T>): Promise<LockResult<T>> {
  const lock = `${file}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let holder = tryLock(lock)
  if (holder !== undefined && !isAlive(holder)) {
    if (readHolder(lock) === holder) fs.rmSync(lock, { force: true })
    holder = tryLock(lock)
  }
  if (holder !== undefined) return { ran: false, holder }
  try {
    return { ran: true, value: await fn() }
  } finally {
    if (readHolder(lock) === process.pid) fs.rmSync(lock, { force: true })
  }
}

/** Link-in a complete pid file, which fails atomically when the lock exists; returns the holder then. */
function tryLock(lock: string): number | undefined {
  const tmp = `${lock}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 })
  try {
    fs.linkSync(tmp, lock)
    return undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return readHolder(lock) ?? Number.NaN
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function readHolder(lock: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10)
    return Number.isInteger(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
