import { z } from 'zod'
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

const Row = z.object({
  repo: z.string(),
  pr: z.number().int().nullable(),
  runId: z.string(),
  phase: z.enum(PHASES),
  headSha: z.string().nullable(),
  stalled: z.object({ reason: z.string() }).nullable(),
})
export type ShepherdRow = z.infer<typeof Row>

/** Every shepherded PR, from `shepherd status --json`; undefined when Shepherd is down or answers in another shape. */
export function shepherdRows(exec: Runner = run): ShepherdRow[] | undefined {
  const result = exec(SHEPHERD_BIN, ['shepherd', 'status', '--json'])
  if (result.status !== 0) return undefined
  try {
    const parsed = z.array(Row).safeParse(JSON.parse(result.stdout))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

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
}

export type RegisterReply = { ok: true } | { ok: false; refused: boolean; reason: string }

/** Idempotent on `repo#pr` at Shepherd's end, so a repeat after an unanswered call starts no second run. */
export function registerWithShepherd(reg: Registration, exec: Runner = run): RegisterReply {
  const args = ['shepherd', 'register', targetRef(reg.target), '--task', reg.task, '--implementer', reg.implementer]
  const result = exec(SHEPHERD_BIN, [...args, '--json'])
  if (result.status === 0) return { ok: true }
  const reason = firstLine(result.stderr) ?? (result.status === null ? 'did not run' : `exit ${result.status}`)
  return { ok: false, refused: result.status === REFUSED_EXIT, reason }
}

const firstLine = (text: string | undefined): string | undefined =>
  text
    ?.split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0)
    ?.slice(0, 300)
