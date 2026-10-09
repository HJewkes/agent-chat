import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { logEvent } from '../../broker/log.js'
import { childEnv, run, type Runner } from './exec.js'

/**
 * Burndown's only door to Shepherd, the factory's PR-shepherding service: the
 * `titan-factory shepherd` CLI. Shepherd owns CI, review and merge for a
 * registered PR; burndown registers a finished worker's PR and reads where the
 * run is. Every read that fails is "could not tell", never a phase.
 */

export const SHEPHERD_BIN = 'titan-factory'

/** sysexits DATAERR: Shepherd refused the registration (a denied repo, a branch already taken), as opposed to being down. */
const REFUSED_EXIT = 65

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
})

/**
 * A row in a phase this build does not know reads as `unknown`: kept, so its
 * claim still finds it and is neither re-registered nor taken as merged or ended.
 */
export type ShepherdRow = Omit<z.infer<typeof Row>, 'phase'> & {
  phase: (typeof PHASES)[number] | 'unknown'
}

type Log = (event: string, detail: Record<string, unknown>) => void

export const SHEPHERD_STATUS_ARGS = ['shepherd', 'status', '--json']

/**
 * Every shepherded PR, from `shepherd status --json`; undefined when Shepherd is
 * down or the answer is not a JSON array. Read row by row: a malformed row is
 * skipped and an unknown phase kept as `unknown`, each logged once per read.
 */
export function shepherdRows(exec: Runner = run, log: Log = logEvent): ShepherdRow[] | undefined {
  const result = exec(SHEPHERD_BIN, SHEPHERD_STATUS_ARGS)
  return result.status === 0 ? parseShepherdRows(result.stdout, log) : undefined
}

const STATUS_TIMEOUT_MS = 15_000
/** Shepherd lists its finished runs too, so the answer can outgrow execFile's 1 MB default. */
const STATUS_MAX_BYTES = 64 * 1024 * 1024

/** CC-863: `shepherdRows` without blocking, for the broker, whose event loop serves every session. */
export async function shepherdRowsAsync(
  log: Log = logEvent,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<ShepherdRow[] | undefined> {
  try {
    const { stdout } = await promisify(execFile)(SHEPHERD_BIN, SHEPHERD_STATUS_ARGS, {
      env: childEnv(),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: STATUS_MAX_BYTES,
    })
    return parseShepherdRows(stdout, log)
  } catch {
    return undefined
  }
}

/** `shepherd status --json` output as rows; undefined when it is not a JSON array. */
export function parseShepherdRows(stdout: string, log: Log = logEvent): ShepherdRow[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  return parsed.flatMap((raw, index) => readRow(raw, index, log))
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

const TimelineStep = z.object({ kind: z.string(), stepId: z.string().optional() })

/** Whether the run recorded `sh-landed`, its one merged exit; a finished run may also have stopped on a closed PR. */
export function shepherdLanded(t: ShepherdTarget, exec: Runner = run): boolean | undefined {
  const result = exec(SHEPHERD_BIN, ['shepherd', 'timeline', targetRef(t), '--json'])
  if (result.status !== 0) return undefined
  try {
    const parsed = z.object({ entries: z.array(TimelineStep) }).safeParse(JSON.parse(result.stdout))
    if (!parsed.success) return undefined
    return parsed.data.entries.some(e => e.kind === 'step' && e.stepId?.split(':')[0] === 'sh-landed')
  } catch {
    return undefined
  }
}

export interface Registration {
  target: ShepherdTarget
  /** `<initiative>/<task id>`, as Shepherd's `--task` takes it. */
  task: string
  /** The agent Shepherd wakes to push fixes. */
  implementer: string
  /** The PR's current head; when known, a listed row at any other head is stale. */
  headSha?: string
  /** Shepherd's `--kind`; absent, the flag is left off so a worker's own kind survives. */
  kind?: ShepherdKind
  /** Shepherd's `--policy`, which can only narrow the seat's policy. */
  policy?: { merge: 'owner-gate' }
}

export type ShepherdKind = 'correctness' | 'security' | 'feature' | 'refactor' | 'unknown'

/** The PR's head sha as GitHub reports it now; a refused PR has no Shepherd row to read it from. */
export function prHeadOf(target: ShepherdTarget, exec: Runner = run): string | undefined {
  const result = exec('gh', ['api', `repos/${target.repo}/pulls/${target.pr}`, '--jq', '.head.sha'])
  const sha = result.status === 0 ? result.stdout.trim() : ''
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined
}

export type RegisterReply = { ok: true } | { ok: false; refused: boolean; reason: string }

/** Idempotent on `repo#pr` at Shepherd's end, so a repeat after an unanswered call starts no second run. */
export function registerWithShepherd(reg: Registration, exec: Runner = run): RegisterReply {
  // A worker registers its own PR with a --kind; a repeat here would clear it.
  const listed = shepherdRows(exec)
  const row = listed && rowFor(listed, reg.target)
  if (row && isLiveAtHead(row, reg.headSha)) return { ok: true }
  return shepherdRegister(reg, exec)
}

/**
 * `shepherd register` itself, with no listing first. A repeat updates the run in
 * place and recomputes its policy from the seat narrowed by this call's `--policy`,
 * so a repeat without one drops a narrowing an earlier call set.
 */
export function shepherdRegister(reg: Registration, exec: Runner = run): RegisterReply {
  const args = [
    'shepherd',
    'register',
    targetRef(reg.target),
    '--task',
    reg.task,
    '--implementer',
    reg.implementer,
    ...(reg.kind === undefined ? [] : ['--kind', reg.kind]),
    ...(reg.policy === undefined ? [] : ['--policy', JSON.stringify(reg.policy)]),
  ]
  const result = exec(SHEPHERD_BIN, [...args, '--json'])
  if (result.status === 0) return { ok: true }
  const reason =
    firstLine(result.stderr) ?? (result.status === null ? 'did not run' : `exit ${result.status}`)
  return { ok: false, refused: result.status === REFUSED_EXIT, reason }
}

/**
 * Every `repo#pr` (lowercased) that `shepherd status --json` lists, a row the
 * schema skips as malformed included, so no caller re-registers it; undefined
 * when Shepherd is down or the answer is not a JSON array.
 */
export function shepherdListed(exec: Runner = run): Set<string> | undefined {
  const result = exec(SHEPHERD_BIN, SHEPHERD_STATUS_ARGS)
  if (result.status !== 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const ListedRef = z.object({ repo: z.string(), pr: z.number().int() })
  return new Set(
    parsed.flatMap(raw => {
      const ref = ListedRef.safeParse(raw)
      return ref.success ? [targetRef(ref.data).toLowerCase()] : []
    }),
  )
}

/** `shepherd hold`, so no merge goes through until the hold is released; false when Shepherd did not take it. */
export function holdWithShepherd(target: ShepherdTarget, reason: string, exec: Runner = run): boolean {
  return (
    exec(SHEPHERD_BIN, ['shepherd', 'hold', targetRef(target), '--reason', reason, '--json']).status === 0
  )
}

const FINISHED_PHASES: readonly ShepherdRow['phase'][] = ['done', 'failed', 'cancelled']

/** A finished run, or one at another head, no longer watches this PR. */
const isLiveAtHead = (row: ShepherdRow, headSha: string | undefined): boolean =>
  !FINISHED_PHASES.includes(row.phase) && (headSha === undefined || row.headSha === headSha)

const firstLine = (text: string | undefined): string | undefined =>
  text
    ?.split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0)
    ?.slice(0, 300)
