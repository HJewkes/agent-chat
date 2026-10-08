import { z } from 'zod'
import { logEvent } from '../../broker/log.js'
import { run, type Runner } from './exec.js'

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
})

/**
 * A row in a phase this build does not know reads as `unknown`: kept, so its
 * claim still finds it and is neither re-registered nor taken as merged or ended.
 */
export type ShepherdRow = Omit<z.infer<typeof Row>, 'phase'> & {
  phase: (typeof PHASES)[number] | 'unknown'
}

type Log = (event: string, detail: Record<string, unknown>) => void

/**
 * Every shepherded PR, from `shepherd status --json`; undefined when Shepherd is
 * down or the answer is not a JSON array. Read row by row: a malformed row is
 * skipped and an unknown phase kept as `unknown`, each logged once per read.
 */
export function shepherdRows(exec: Runner = run, log: Log = logEvent): ShepherdRow[] | undefined {
  const result = exec(SHEPHERD_BIN, ['shepherd', 'status', '--json'])
  if (result.status !== 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
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
}

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
  const args = [
    'shepherd',
    'register',
    targetRef(reg.target),
    '--task',
    reg.task,
    '--implementer',
    reg.implementer,
  ]
  const result = exec(SHEPHERD_BIN, [...args, '--json'])
  if (result.status === 0) return { ok: true }
  const reason =
    firstLine(result.stderr) ?? (result.status === null ? 'did not run' : `exit ${result.status}`)
  return { ok: false, refused: result.status === REFUSED_EXIT, reason }
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
