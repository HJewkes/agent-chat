import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { planPathFor } from './brief.js'
import { briefReviewSection, type WakeDelivery } from './decider.js'
import type { Task } from './eligibility.js'
import { declaredOps, opsLint, opsNoneTag } from './ops.js'
import { readSlices } from './report.js'
import { parseTask, readTaskText, readTasks } from './source.js'
import type { Report } from '../../cli/command.js'

const PROPOSED = 'brief:proposed='
const BRIEF_SRC = 'brief:src='
const BRIEFER_SRC = 'brief:src=briefer'
const BRIEF_READY = /^brief:ready(=|$)/

/** What approval touches outside its own logic, so a test can stand in for the disk and `active-work`. */
export interface ApprovePorts {
  root: string
  initiatives: () => string[]
  planExists: (path: string) => boolean
  /** `active-work task edit <slug> <id> ...args`; throws on a non-zero exit. */
  edit: (slug: string, id: string, args: string[]) => void
}

/**
 * CC-1076: whether a briefer has answered, read by the tick when the briefer's claim finishes.
 * Approval swaps `brief:proposed` for `brief:ready` plus `brief:src=briefer`, adding both before removing
 * the proposal, so every state the task passes through satisfies this whichever of approve and tick runs first.
 */
export const briefAnswered = (tags: readonly string[]): boolean =>
  tags.some(t => t.startsWith(PROPOSED) || t === 'brief:proposed') ||
  (tags.includes(BRIEFER_SRC) && tags.some(t => BRIEF_READY.test(t)))

const refused = (message: string): Report => ({ ok: false, lines: [], errors: [message] })

/**
 * CC-1154: the ops tag promotion adds so the dispatch gate never meets an untagged done_when.
 * An unresolved hit is refused, not tagged `ops:none`: whether it is a human step is the approver's call.
 */
function opsTagEdits(
  taskId: string,
  doneWhen: string | undefined,
  tags: readonly string[],
): string[] | Report {
  if (doneWhen === undefined) return []
  const hits = opsLint(doneWhen, tags)
  const none = opsNoneTag(doneWhen)
  if (hits.length > 0) {
    const named = hits.map(hit => `${hit.op} ('${hit.text}')`).join(', ')
    return refused(
      `${taskId}: done_when mentions ${named}; tag ops:<op> for a human step, or ${none} if it is subject matter, then approve again`,
    )
  }
  return tags.includes(none) || declaredOps(tags).length > 0 ? [] : [none]
}

/**
 * CC-940: promotes a briefer's `brief:proposed=<day>` to `brief:ready=<today>` and records `brief:src=briefer` (replacing any other src) through `active-work task edit`.
 * Refused when the task is unknown, carries no proposal, its plan file is missing, or its done_when has an unresolved ops hit.
 */
export function approveBrief(taskId: string, ports: ApprovePorts, today: string): Report {
  const slug = ports.initiatives().find(s => readTaskText(ports.root, s, taskId) !== undefined)
  if (slug === undefined) return refused(`no task ${taskId} in any initiative`)
  return promoteBrief(slug, taskId, ports, today)
}

function promoteBrief(slug: string, taskId: string, ports: ApprovePorts, today: string): Report {
  const { tags, doneWhen } = parseTask(readTaskText(ports.root, slug, taskId) ?? '', taskId)
  const proposed = tags.find(t => t.startsWith(PROPOSED))
  if (proposed === undefined) return refused(`${taskId} carries no brief:proposed tag`)
  const plan = planPathFor(path.join(ports.root, slug), taskId)
  if (!ports.planExists(plan)) return refused(`no plan file at ${plan}`)
  const opsTags = opsTagEdits(taskId, doneWhen, tags)
  if (!Array.isArray(opsTags)) return opsTags
  try {
    const ready = `brief:ready=${today}`
    // Add first: a failure after it leaves the task with a ready tag, and a rerun finishes the cleanup.
    for (const tag of opsTags) ports.edit(slug, taskId, ['--add-tag', tag])
    if (!tags.includes(ready)) ports.edit(slug, taskId, ['--add-tag', ready])
    if (!tags.includes(BRIEFER_SRC)) ports.edit(slug, taskId, ['--add-tag', BRIEFER_SRC])
    const stale = (t: string) =>
      t !== ready &&
      (t.startsWith(PROPOSED) || BRIEF_READY.test(t) || (t.startsWith(BRIEF_SRC) && t !== BRIEFER_SRC))
    for (const old of tags.filter(stale)) ports.edit(slug, taskId, ['--remove-tag', old])
  } catch (err) {
    return refused(`active-work task edit failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: true, lines: [`${taskId}: ${proposed} -> brief:ready=${today}`] }
}

/** CC-1234: a task or plan flagged for the human is never approved by the tick. */
const HUMAN_FLAGS = ['needs-human', 'human-only', 'brief:needs-human']
const PLAN_HUMAN_FLAG = /^\s*(?:[-*]\s*)?needs-human\b/im
/** Records the brief version already sent to the decider, so each version is sent at most once. */
const DECIDER_SENT = 'brief:decider='

/** `quiet` skips a task the tick has no business reporting on every tick, such as a closed one. */
export type BriefVerdict =
  | { kind: 'approve'; plan: string }
  | { kind: 'decider'; plan: string; problems: string[] }
  | { kind: 'skip'; reason: string; quiet?: true }

/** CC-1234 (G10): fail closed. Only an open, unflagged task whose plan passes the slice lint is approved. */
export function briefVerdict(task: Task, plan: string | undefined): BriefVerdict {
  if (task.status !== 'open')
    return { kind: 'skip', reason: `status is ${task.status ?? 'unset'}`, quiet: true }
  const flag = task.tags.find(t => HUMAN_FLAGS.includes(t))
  if (flag !== undefined) return { kind: 'skip', reason: `tagged ${flag}` }
  if (plan === undefined) return { kind: 'skip', reason: 'no readable plan file' }
  if (PLAN_HUMAN_FLAG.test(plan)) return { kind: 'skip', reason: 'plan is flagged needs-human' }
  const problems = sliceProblems(plan)
  return problems.length === 0 ? { kind: 'approve', plan } : { kind: 'decider', plan, problems }
}

function sliceProblems(plan: string): string[] {
  try {
    return readSlices(plan).problems ?? []
  } catch (err) {
    return [`slice lint threw: ${err instanceof Error ? err.message : String(err)}`]
  }
}

/** A proposal and its plan text: a briefer's rewrite or re-proposal is a new version the decider sees again. */
export const briefVersion = (proposed: string, plan: string): string =>
  createHash('sha256').update(`${proposed}\n${plan}`).digest('hex').slice(0, 12)

export interface AutoApprovePorts extends ApprovePorts {
  tasks: (slug: string) => Task[]
  /** The plan's text, or undefined when it is missing or unreadable. */
  readPlan: (file: string) => string | undefined
}

export interface AutoApproveDeps {
  today: string
  dryRun: boolean
  /** False when no decider is configured: a failing brief is then left for the seat. */
  decider: boolean
}

/**
 * A failing brief bound for the decider. The tick sends it inside its one decider wake (CC-1234), so brief sends
 * share the queue wake's identity, active-state, rate-cap and capacity checks and are counted with it.
 * `tag` is written by `recordBriefRoutes` just before the wake, never while settling.
 */
export interface BriefRoute {
  slug: string
  taskId: string
  tag: string
  /** Older version records, dropped once this version is sent. */
  stale: string[]
  section: string
}

/** CC-1193: a brief this tick approved, which edited its task file before the world was read. */
export interface BriefApproval {
  slug: string
  taskId: string
}

export interface SettledBriefs {
  lines: string[]
  routes: BriefRoute[]
  approved: BriefApproval[]
}

interface Proposal {
  slug: string
  task: Task
  proposed: string
  planFile: string
}

/** CC-1234: every open `brief:proposed` task is approved on this tick when its plan lints; the rest are routes for the decider wake. */
export function settleProposedBriefs(ports: AutoApprovePorts, deps: AutoApproveDeps): SettledBriefs {
  const settled: SettledBriefs = { lines: [], routes: [], approved: [] }
  for (const proposal of proposals(ports)) {
    const one = settleBrief(proposal, ports, deps)
    settled.lines.push(...one.lines)
    settled.routes.push(...one.routes)
    settled.approved.push(...one.approved)
  }
  return settled
}

function proposals(ports: AutoApprovePorts): Proposal[] {
  return ports.initiatives().flatMap(slug =>
    ports.tasks(slug).flatMap(task => {
      const proposed = task.tags.find(t => t.startsWith(PROPOSED))
      if (proposed === undefined) return []
      return [{ slug, task, proposed, planFile: planPathFor(path.join(ports.root, slug), task.id) }]
    }),
  )
}

const linesOnly = (...lines: string[]): SettledBriefs => ({ lines, routes: [], approved: [] })

function settleBrief(p: Proposal, ports: AutoApprovePorts, deps: AutoApproveDeps): SettledBriefs {
  const verdict = briefVerdict(p.task, ports.readPlan(p.planFile))
  if (verdict.kind === 'skip')
    return verdict.quiet === true
      ? linesOnly()
      : linesOnly(`brief ${p.task.id} not auto-approved: ${verdict.reason}`)
  if (verdict.kind === 'decider') return routeBrief(p, verdict.plan, verdict.problems, deps)
  if (deps.dryRun) return linesOnly(`would approve brief ${p.task.id}: slice lint passed`)
  const report = promoteBrief(p.slug, p.task.id, ports, deps.today)
  if (!report.ok) return routeBrief(p, verdict.plan, report.errors ?? [], deps)
  const lines = [
    ...report.lines.map(line => `${line} (auto: slice lint passed)`),
    ...auditNote(p, ports, deps.today),
  ]
  return { lines, routes: [], approved: [{ slug: p.slug, taskId: p.task.id }] }
}

function auditNote(p: Proposal, ports: ApprovePorts, today: string): string[] {
  const note = `${today}: burndown tick auto-approved ${p.proposed} -> brief:ready=${today}; the plan passed the slice lint (CC-1234).`
  try {
    ports.edit(p.slug, p.task.id, ['--append', note])
    return []
  } catch (err) {
    return [`${p.task.id}: audit note not written: ${err instanceof Error ? err.message : String(err)}`]
  }
}

function routeBrief(p: Proposal, plan: string, problems: string[], deps: AutoApproveDeps): SettledBriefs {
  const id = p.task.id
  const tag = `${DECIDER_SENT}${briefVersion(p.proposed, plan)}`
  const head = `brief ${id} not auto-approved (${problems.length} problem(s))`
  if (p.task.tags.includes(tag)) return linesOnly(`${head}; this version is already with the decider`)
  if (!deps.decider) return linesOnly(`${head}; no decider configured, left for the seat`)
  const stale = p.task.tags.filter(t => t.startsWith(DECIDER_SENT) && t !== tag)
  const section = briefReviewSection(p.slug, id, p.planFile, problems)
  const route = { slug: p.slug, taskId: id, tag, stale, section }
  return { lines: [`${head}; for the decider`], routes: [route], approved: [] }
}

/**
 * Intent first, written only once the tick has decided to wake the decider and right before the resume, so a tick
 * that fails earlier leaves no record and the next tick sends the brief. A route whose record fails is not sent,
 * and its tag is removed in case the add wrote it before failing, so the next tick routes it again.
 */
export function recordBriefRoutes(
  routes: readonly BriefRoute[],
  ports: Pick<ApprovePorts, 'edit'>,
): { recorded: BriefRoute[]; lines: string[] } {
  const recorded: BriefRoute[] = []
  const lines: string[] = []
  for (const route of routes)
    if (tryEdit(ports, route.slug, route.taskId, ['--add-tag', route.tag])) recorded.push(route)
    else {
      tryEdit(ports, route.slug, route.taskId, ['--remove-tag', route.tag])
      lines.push(
        `brief ${route.taskId} not sent to the decider: could not record the send; retried next tick`,
      )
    }
  return { recorded, lines }
}

/** A sent or possibly-sent wake keeps each recorded route's record; any other outcome drops it so the next tick retries. */
export function finishBriefRoutes(
  routes: readonly BriefRoute[],
  delivery: WakeDelivery,
  ports: Pick<ApprovePorts, 'edit'>,
): string[] {
  const kept = delivery.sent || delivery.unknown === true
  return routes.map(route => {
    for (const old of kept ? route.stale : [route.tag])
      tryEdit(ports, route.slug, route.taskId, ['--remove-tag', old])
    return kept
      ? `brief ${route.taskId} sent to the decider`
      : `brief ${route.taskId} not sent to the decider: ${delivery.reason}; retried next tick`
  })
}

function tryEdit(ports: Pick<ApprovePorts, 'edit'>, slug: string, id: string, args: string[]): boolean {
  try {
    ports.edit(slug, id, args)
    return true
  } catch {
    return false
  }
}

export function autoApprovePortsOn(root: string): AutoApprovePorts {
  return {
    ...approvePortsOn(root),
    tasks: slug => readTasks(root, slug),
    readPlan: file => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    },
  }
}

export function approvePortsOn(root: string): ApprovePorts {
  return {
    root,
    initiatives: () =>
      fs.readdirSync(root, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? [e.name] : [])),
    planExists: file => fs.existsSync(file),
    edit: (slug, id, args) => {
      // ACTIVE_ROOT pins the CLI to the root this read, so an edit never lands in another tree.
      execFileSync('active-work', ['task', 'edit', slug, id, ...args], {
        stdio: 'pipe',
        timeout: 30_000,
        env: { ...process.env, ACTIVE_ROOT: root },
      })
    },
  }
}
