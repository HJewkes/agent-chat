import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import { logEvent } from './broker/log.js'
import { childEnv, describeExecFailure, run, type Runner } from './exec.js'

/**
 * The read half of agent-chat's door to Shepherd, the factory's PR-shepherding
 * service: `titan-factory shepherd status`. The broker, teleport, seats and
 * burndown read where a run is here; burndown's write path stays in
 * `agents/burndown/shepherd.ts`. Every read that fails is "could not tell", never a phase.
 */

export const SHEPHERD_BIN = 'titan-factory'

/** A GitHub PR as Shepherd names it. */
export interface ShepherdTarget {
  repo: string
  pr: number
}

export const targetRef = (t: ShepherdTarget): string => `${t.repo}#${t.pr}`

/** `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>`; anything else Shepherd cannot take. */
export function shepherdTarget(pr: string | undefined): ShepherdTarget | undefined {
  if (pr === undefined) return undefined
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(pr) ??
    /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(pr)
  return match === null ? undefined : { repo: match[1] as string, pr: Number(match[2]) }
}

const PHASES = [
  'awaiting-pr',
  'ci',
  'fixing',
  'review',
  'awaiting-approval',
  'merging',
  'post-merge',
  'done',
  'failed',
  'cancelled',
] as const

const KNOWN_PHASES: ReadonlySet<string> = new Set(PHASES)

/** `phase` is any string here so one row in a phase Shepherd added later does not fail the read (CC-791). */
const Row = z.object({
  repo: z.string(),
  pr: z.number().int().nullable(),
  runId: z.string(),
  phase: z.string(),
  headSha: z.string().nullable(),
  stalled: z.object({ reason: z.string() }).nullable(),
  /** CC-863: read only to name the run's agent and task in a seat's teleport State; absent on an older Shepherd. */
  branch: z.string().nullable().optional(),
  task: z.string().nullable().optional(),
  held: z.object({ reason: z.string() }).nullable().optional(),
  /** CC-934: read only to print a seat's boot In flight; the shape is Shepherd's, so it is not narrowed here. */
  nextAction: z.unknown().optional(),
  pendingGate: z.unknown().optional(),
  /** TP-1570: read only to write a retiring seat agent's merged row; absent on an older Shepherd. */
  implementer: z.string().nullable().optional(),
  outcome: z.object({ kind: z.string() }).nullable().optional().catch(null),
  /** CC-1262: past its fix-round limit, so no new child stacks on it; absent on an older Shepherd. */
  stackFrozen: z.boolean().optional(),
})

/**
 * A row in a phase this build does not know reads as `unknown`: kept, so its
 * claim still finds it and is neither re-registered nor taken as merged or ended.
 */
export type ShepherdRow = Omit<z.infer<typeof Row>, 'phase'> & {
  phase: (typeof PHASES)[number] | 'unknown'
}

/** A held run's hold class: its reason's text before the first ":", or undefined when unheld or unclassed. */
export function holdClass(row: Pick<ShepherdRow, 'held'>): string | undefined {
  const reason = row.held?.reason
  const colon = reason?.indexOf(':') ?? -1
  return reason === undefined || colon === -1 ? undefined : reason.slice(0, colon)
}

type Log = (event: string, detail: Record<string, unknown>) => void

export const SHEPHERD_STATUS_ARGS = ['shepherd', 'status', '--json']
/** TP-2516: the bare form leaves out done, failed and cancelled runs; these readers need them. */
export const SHEPHERD_STATUS_ALL_ARGS = [...SHEPHERD_STATUS_ARGS, '--all']

/**
 * Every shepherded PR, from `shepherd status --json`; undefined when Shepherd is
 * down or the answer is not a JSON array. Read row by row: a malformed row is
 * skipped and an unknown phase kept as `unknown`, each logged once per read.
 */
export function shepherdRows(exec: Runner = run, log: Log = logEvent): ShepherdRow[] | undefined {
  const result = exec(SHEPHERD_BIN, SHEPHERD_STATUS_ALL_ARGS)
  return result.status === 0 ? parseShepherdRows(result.stdout, log) : undefined
}

const STATUS_TIMEOUT_MS = 15_000
/** With `--all` Shepherd lists its finished runs too, so the answer can outgrow execFile's 1 MB default. */
const STATUS_MAX_BYTES = 64 * 1024 * 1024

/**
 * CC-863: `shepherdRows` without blocking, for the broker, whose event loop serves every session.
 * CC-1096: runs in HOME, since the broker's cwd can be a removed tree, and logs why a read failed.
 */
export async function shepherdRowsAsync(
  log: Log = logEvent,
  timeoutMs = STATUS_TIMEOUT_MS,
  bin = SHEPHERD_BIN,
): Promise<ShepherdRow[] | undefined> {
  const cwd = homedir()
  const started = performance.now()
  try {
    const { stdout } = await promisify(execFile)(bin, SHEPHERD_STATUS_ALL_ARGS, {
      cwd,
      env: childEnv(),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: STATUS_MAX_BYTES,
    })
    return parseShepherdRows(stdout, log)
  } catch (err) {
    log('shepherd_status_failed', {
      error: describeExecFailure(err, { cwd, elapsedMs: performance.now() - started }),
    })
    return undefined
  }
}

/** `shepherd status --json` output as rows; undefined when it is not a JSON array. */
export function parseShepherdRows(stdout: string, log: Log = logEvent): ShepherdRow[] | undefined {
  const parsed = parseJson(stdout)
  return Array.isArray(parsed) ? parsed.flatMap((raw, index) => readRow(raw, index, log)) : undefined
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    return undefined
  }
}

/** Shepherd's review spawn gate: `cap` is the live `review.maxConcurrent`; `running` is absent when its roster was unread. */
export interface ReviewSlots {
  cap: number
  running?: string[]
}

export interface ShepherdStatus {
  rows: ShepherdRow[]
  /** Absent from an older Shepherd, or from one whose answer carried no readable slots. */
  reviewSlots?: ReviewSlots
}

/** CC-1106: `--deploy` wraps the rows as `{rows, deploy, reviewSlots}`; `--all` still lists finished runs under it. */
export const SHEPHERD_STATUS_DEPLOY_ARGS = [...SHEPHERD_STATUS_ALL_ARGS, '--deploy']

const ReviewSlotsBody = z.object({
  cap: z.number().int().nonnegative(),
  running: z.array(z.string()).optional(),
  rosterError: z.string().optional(),
})

/** Every shepherded PR plus Shepherd's review slots, in one read; undefined when Shepherd is down or the answer is malformed. */
export function shepherdStatus(exec: Runner = run, log: Log = logEvent): ShepherdStatus | undefined {
  const result = exec(SHEPHERD_BIN, SHEPHERD_STATUS_DEPLOY_ARGS)
  return result.status === 0 ? parseShepherdStatus(result.stdout, log) : undefined
}

/**
 * `shepherd status --json --deploy` output. A bare array (an older Shepherd) parses with no slots. A `rosterError`
 * keeps `cap` and drops `running`, since a failed roster read says nothing about how many reviewers run.
 */
export function parseShepherdStatus(stdout: string, log: Log = logEvent): ShepherdStatus | undefined {
  const parsed = parseJson(stdout)
  const body = (Array.isArray(parsed) ? { rows: parsed } : parsed) as
    { rows?: unknown; reviewSlots?: unknown } | null | undefined
  if (typeof body !== 'object' || body === null || !Array.isArray(body.rows)) return undefined
  const rows = body.rows.flatMap((raw: unknown, index) => readRow(raw, index, log))
  const slots = reviewSlotsOf(body.reviewSlots, log)
  return slots === undefined ? { rows } : { rows, reviewSlots: slots }
}

function reviewSlotsOf(raw: unknown, log: Log): ReviewSlots | undefined {
  if (raw === undefined) return undefined
  const parsed = ReviewSlotsBody.safeParse(raw)
  if (!parsed.success) {
    log('shepherd_review_slots_unread', { reason: parsed.error.issues.map(i => i.message).join('; ') })
    return undefined
  }
  const { cap, running, rosterError } = parsed.data
  return running === undefined || rosterError !== undefined ? { cap } : { cap, running }
}

function readRow(raw: unknown, index: number, log: Log): ShepherdRow[] {
  const parsed = Row.safeParse(raw)
  if (!parsed.success) {
    const reason = parsed.error.issues.map(i => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ')
    log('burndown_shepherd_row_skipped', { index, reason })
    return []
  }
  const row = parsed.data
  if (KNOWN_PHASES.has(row.phase)) return [row as ShepherdRow]
  log('burndown_shepherd_row_unknown_phase', { target: rowRef(row), runId: row.runId, phase: row.phase })
  return [{ ...row, phase: 'unknown' }]
}

const rowRef = (row: { repo: string; pr: number | null }): string =>
  row.pr === null ? row.repo : `${row.repo}#${row.pr}`

/** Shepherd lowercases the repos it stores, so a target matches its row case-insensitively. */
export const rowFor = (rows: readonly ShepherdRow[], t: ShepherdTarget): ShepherdRow | undefined =>
  rows.find(r => r.pr === t.pr && r.repo.toLowerCase() === t.repo.toLowerCase())

export const FINISHED_PHASES: readonly ShepherdRow['phase'][] = ['done', 'failed', 'cancelled']
