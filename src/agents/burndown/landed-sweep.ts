import { LANDING_LOG_FORMAT, landingLines, namesId } from './collision.js'
import { run, type Runner } from './exec.js'
import { defaultBranch } from './observe.js'
import { loadPolicy, seatScope } from './policy.js'
import { GIT_BIN } from './review-diff.js'
import { readScoredTasks } from './score-source.js'
import { resolveSeatDispatch } from './seat-dispatch.js'
import { readInitiatives } from './source.js'

/**
 * CC-611: every open task in a seat's scope checked against recent default-branch subjects or Covers clauses, not just the
 * rows a plan walk reaches. A landed task ranked below every cap is never dispatched, so the collision
 * check never refuses it either, and it stays open unless something reports it. Read-only.
 */

export interface SweepTask {
  id: string
  initiative: string
  tags: readonly string[]
}

/** One repo's subjects; `undefined` means the read failed. */
export interface SubjectRead {
  repo: string
  subjects: string[] | undefined
}

export type LandedRow =
  | { kind: 'landed'; id: string; initiative: string; repo: string; subject: string }
  | { kind: 'unreadable'; repo: string }

const RECONCILED = 'reconciled'

const byId = (a: SweepTask, b: SweepTask): number => a.id.localeCompare(b.id, 'en', { numeric: true })

/** Unreadable repos first, then each unreconciled task a subject names, in task-id order; a failed repo never hides another's hits. */
export function landedSweep(tasks: readonly SweepTask[], reads: readonly SubjectRead[]): LandedRow[] {
  const unreadable: LandedRow[] = reads
    .filter(read => read.subjects === undefined)
    .map(read => ({ kind: 'unreadable', repo: read.repo }))
  const landed = [...tasks]
    .filter(task => !task.tags.some(tag => tag.startsWith(RECONCILED)))
    .sort(byId)
    .flatMap(task => landedRow(task, reads))
  return [...unreadable, ...landed]
}

function landedRow(task: SweepTask, reads: readonly SubjectRead[]): LandedRow[] {
  for (const { repo, subjects } of reads) {
    const subject = subjects?.find(s => namesId(s, task.id))
    if (subject !== undefined)
      return [{ kind: 'landed', id: task.id, initiative: task.initiative, repo, subject }]
  }
  return []
}

/** Subjects and Covers clauses on `origin/<branch>` from the last `days` days, fetched first so a landing since the last fetch counts. */
export function readRecentSubjects(
  repo: string,
  branch: string,
  days: number,
  exec: Runner = run,
): string[] | undefined {
  if (exec(GIT_BIN, ['fetch', '--quiet', '--no-tags', 'origin', branch], repo).status !== 0) return undefined
  const result = exec(GIT_BIN, ['log', `origin/${branch}`, `--since=${days}.days`, LANDING_LOG_FORMAT], repo)
  return result.status === 0 ? landingLines(result.stdout) : undefined
}

const REVERT = /^Revert "(.*)"/

/** A subject the parent id opens as a whole token: `A-1: x` or `A-1 b: x`, never `A-9: filed from A-1`. */
const opensWithId = (subject: string, id: string): boolean =>
  subject.toLowerCase().startsWith(id.toLowerCase()) && namesId(subject.slice(0, id.length + 1), id)

/**
 * CC-1227: a default-branch commit for every slice, done or released, and no open PR title naming the parent.
 * A slice commit's subject opens with the parent id, so a later task's subject that mentions it does not count.
 * A revert never counts, nor the commit it reverts. Distinct subjects are counted, and a `[covers ...]` line
 * repeats its commit's subject and counts once. The caller bounds each log to commits since the task began.
 */
export function releasedSlicesLanded(
  taskId: string,
  slices: { done: number; released: number },
  reads: readonly SubjectRead[],
  openPrTitles: readonly string[],
): boolean {
  if (reads.some(read => read.subjects === undefined)) return false
  if (openPrTitles.some(title => namesId(title, taskId))) return false
  const subjects = reads.flatMap(read => read.subjects ?? []).map(s => s.replace(/ \[covers [^\]]*\]$/, ''))
  const reverted = new Set(subjects.flatMap(s => REVERT.exec(s)?.[1] ?? []))
  const commits = subjects.filter(s => opensWithId(s, taskId) && !REVERT.test(s) && !reverted.has(s))
  return slices.released > 0 && new Set(commits).size >= slices.done + slices.released
}

export interface LandedSweep {
  rows: LandedRow[]
  swept: number
  repos: number
}

export interface LandedSweepOptions {
  seat: string
  days: number
  autonomyRoot: string
  activeWorkRoot: string
  exec?: Runner
}

/** The seat's open in-scope tasks against its git checkouts; a `git: false` path is no repo to read (CC-834). */
export function landedSweepFromDisk(opts: LandedSweepOptions): LandedSweep {
  const exec = opts.exec ?? run
  const policy = loadPolicy(opts.autonomyRoot, opts.seat)
  const scope = seatScope(policy.charter, policy.seats, opts.seat, readInitiatives(opts.activeWorkRoot))
  const { tasks } = readScoredTasks(opts.activeWorkRoot, Object.keys(scope))
  const dispatch = resolveSeatDispatch(policy, opts.seat)
  const nonGit = new Set(dispatch.nonGitRepos ?? [])
  const repos = [...new Set(Object.values(dispatch.repos).flat())].filter(repo => !nonGit.has(repo))
  const reads = repos.map(repo => ({
    repo,
    subjects: readRecentSubjects(repo, defaultBranch(repo, exec), opts.days, exec),
  }))
  const sweep = tasks.map(t => ({ id: t.id, initiative: t.slug, tags: t.tags ?? [] }))
  return { rows: landedSweep(sweep, reads), swept: tasks.length, repos: repos.length }
}

/** `LANDED <id>: <repo>: <subject>`, the shape seat-compare already parses, then one summary line. */
export function renderLandedSweep({ rows, swept, repos }: LandedSweep): string[] {
  const lines = rows.map(row =>
    row.kind === 'landed'
      ? `LANDED ${row.id}: ${row.repo}: ${row.subject}`
      : `UNREADABLE ${row.repo}: no default-branch subjects`,
  )
  const landed = rows.filter(row => row.kind === 'landed').length
  return [...lines, `swept ${swept} open tasks in ${repos} repos; ${landed} landed`]
}
