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

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A slice's commit subject opens `<ID> <letter>` as tokens, the form burndown implementers use: `A-1 b: title`. */
const opensSlice = (subject: string, id: string, letter: string): boolean =>
  new RegExp(`^${escaped(id)} ${escaped(letter)}(?![A-Za-z0-9])`, 'i').test(subject)

/**
 * CC-1227: every slice, done or released, has a default-branch commit whose subject opens `<ID> <letter>`, and no
 * open PR title names the parent. A typo fix or a filing commit that merely opens with the id lands no slice, so
 * slices are matched by letter, not counted. A revert never counts, nor the commit it reverts; a `[covers ...]`
 * suffix is dropped. The caller bounds each log to commits since the task began.
 */
export function releasedSlicesLanded(
  taskId: string,
  slices: { done: readonly string[]; released: readonly string[] },
  reads: readonly SubjectRead[],
  openPrTitles: readonly string[],
): boolean {
  if (reads.some(read => read.subjects === undefined)) return false
  if (openPrTitles.some(title => namesId(title, taskId))) return false
  const subjects = reads.flatMap(read => read.subjects ?? []).map(s => s.replace(/ \[covers [^\]]*\]$/, ''))
  const reverted = new Set(subjects.flatMap(s => REVERT.exec(s)?.[1] ?? []))
  const landed = subjects.filter(s => !REVERT.test(s) && !reverted.has(s))
  const letters = [...slices.done, ...slices.released]
  return slices.released.length > 0 && letters.every(l => landed.some(s => opensSlice(s, taskId, l)))
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
