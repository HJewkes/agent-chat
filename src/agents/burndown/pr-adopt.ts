import { BRANCH_PREFIX } from '../isolation/worktree.js'
import type { Task } from './eligibility.js'
import {
  rowFor,
  targetRef,
  type Registration,
  type RegisterReply,
  type ShepherdKind,
  type ShepherdRow,
  type ShepherdTarget,
} from './shepherd.js'

/**
 * CC-861: each tick, register a seat's open PRs that Shepherd does not list, which
 * the coordinator did by hand after every DONE report. A security, authority or
 * merge-policy PR needs a `g10-adversary` hold and a seat reviewer, so it is only
 * flagged in the seat's log, as is any PR the tick cannot classify. Shepherd down
 * is logged and retried next tick; registration never goes `--offline`.
 */

export interface OpenPull {
  number: number
  title: string
  branch: string
  updatedAt: string
}

export interface AdoptSeat {
  seat: string
  prefix: string
  /** The seat's git checkouts and the initiatives whose tasks they carry. */
  repos: { checkout: string; initiatives: string[] }[]
  /** Idle days before an unregistered PR is flagged; absent, none is. */
  staleDays?: number
}

export interface AdoptPorts {
  /** `owner/repo` of a checkout's origin; undefined when it has none on GitHub. */
  repoOf: (checkout: string) => string | undefined
  /** The repo's open PRs, read over REST; undefined when the read failed. */
  pulls: (repo: string) => OpenPull[] | undefined
  diffSize: (target: ShepherdTarget) => { additions: number; deletions: number } | undefined
  task: (initiatives: readonly string[], id: string) => { initiative: string; task: Task } | undefined
  /** Every Shepherd run; undefined when serve did not answer. */
  shepherdRows: () => ShepherdRow[] | undefined
  register: (reg: Registration) => RegisterReply
  hold: (target: ShepherdTarget, reason: string) => boolean
  /** Whether today's seat log already has a line containing `key`. */
  logged: (seat: string, key: string) => boolean
  append: (seat: string, text: string) => void
  log: (event: string, detail: Record<string, unknown>) => void
}

/** Charter G10: a diff over this many changed lines is held for Shepherd's opus review. */
export const G10_DIFF_LINES = 400

const DAY_MS = 86_400_000

const ADVERSARY_WORDS =
  /\b(security|authority|permissions?|merge[- ]policy|trust[- ]gate|grants?|secrets?|credentials?)\b/i

const SHEPHERD_KINDS: Readonly<Record<string, ShepherdKind>> = {
  correctness: 'correctness',
  bug: 'correctness',
  feature: 'feature',
  refactor: 'refactor',
}

type Verdict = { flag: string } | { register: Registration }

/** Registers, holds and flags each seat's unregistered PRs; returns the tick's lines. */
export function adoptSeatPrs(
  seats: readonly AdoptSeat[],
  claimed: ReadonlySet<string>,
  ports: AdoptPorts,
  now: Date,
): string[] {
  if (seats.length === 0) return []
  const rows = ports.shepherdRows()
  if (rows === undefined) {
    ports.log('burndown_pr_adopt_shepherd_down', {})
    return ['shepherd did not answer; seat PR adoption retries next tick']
  }
  return seats.flatMap(seat =>
    seat.repos.flatMap(repo => {
      const slug = ports.repoOf(repo.checkout)
      return slug === undefined ? [] : adoptRepo(seat, slug, repo.initiatives, { rows, claimed, ports, now })
    }),
  )
}

interface RepoCtx {
  rows: readonly ShepherdRow[]
  claimed: ReadonlySet<string>
  ports: AdoptPorts
  now: Date
}

function adoptRepo(seat: AdoptSeat, repo: string, initiatives: string[], ctx: RepoCtx): string[] {
  const pulls = ctx.ports.pulls(repo)
  if (pulls === undefined) {
    ctx.ports.log('burndown_pr_adopt_read_failed', { seat: seat.seat, repo })
    return []
  }
  const own = `${BRANCH_PREFIX}${seat.prefix}-`
  return pulls
    .filter(p => p.branch.startsWith(own))
    .map(p => ({ pull: p, target: { repo, pr: p.number } }))
    .filter(({ target }) => !rowFor(ctx.rows, target) && !ctx.claimed.has(targetRef(target).toLowerCase()))
    .flatMap(({ pull, target }) => {
      const adopted = adoptPull(seat, pull, target, initiatives, ctx.ports)
      return adopted
        ? [`registered ${targetRef(target)} with Shepherd for seat ${seat.seat}`]
        : staleFlag(seat, pull, target, ctx)
    })
}

/** True once the PR is registered; false leaves it unregistered for the stale check. */
function adoptPull(
  seat: AdoptSeat,
  pull: OpenPull,
  target: ShepherdTarget,
  initiatives: readonly string[],
  ports: AdoptPorts,
): boolean {
  const verdict = classify(pull, target, initiatives, ports)
  if ('flag' in verdict) {
    flagOnce(seat.seat, `burndown: ${targetRef(target)} unregistered`, verdict.flag, ports)
    return false
  }
  const size = ports.diffSize(target)
  if (size === undefined) {
    ports.log('burndown_pr_adopt_size_unread', { seat: seat.seat, target: targetRef(target) })
    return false
  }
  return registerAndHold(seat, verdict.register, size, ports)
}

function registerAndHold(
  seat: AdoptSeat,
  reg: Registration,
  size: { additions: number; deletions: number },
  ports: AdoptPorts,
): boolean {
  const ref = targetRef(reg.target)
  const reply = ports.register(reg)
  if (!reply.ok) {
    ports.log('burndown_pr_adopt_register_failed', { seat: seat.seat, target: ref, reason: reply.reason })
    if (reply.refused) flagOnce(seat.seat, `burndown: ${ref} refused`, `by Shepherd: ${reply.reason}`, ports)
    return false
  }
  if (size.additions + size.deletions <= G10_DIFF_LINES) return true
  const taskId = reg.task.split('/').pop() ?? reg.task
  const reason = `g10-review: diff +${size.additions}/-${size.deletions} over ${G10_DIFF_LINES} (size only); ${taskId}`
  if (!ports.hold(reg.target, reason)) {
    ports.log('burndown_pr_adopt_hold_failed', { seat: seat.seat, target: ref })
    flagOnce(seat.seat, `burndown: ${ref} not held`, `registered, but hold it by hand: ${reason}`, ports)
  }
  return true
}

/** The registration, or why the seat must decide: the task or its kind is unknown, or it is an adversary class. */
function classify(
  pull: OpenPull,
  target: ShepherdTarget,
  initiatives: readonly string[],
  ports: AdoptPorts,
): Verdict {
  const implementer = pull.branch.slice(BRANCH_PREFIX.length)
  const id = /^[a-z0-9]+-([a-z]+-\d+)/.exec(implementer)?.[1]?.toUpperCase()
  if (id === undefined) return { flag: `no task id in branch ${pull.branch}` }
  const found = ports.task(initiatives, id)
  if (found === undefined) return { flag: `task ${id} not found in the seat's initiatives` }
  const kind = found.task.tags.find(t => t.startsWith('kind:'))?.slice('kind:'.length)
  if (kind === undefined || kind === '') return { flag: `task ${id} has no kind: tag` }
  if (isAdversaryClass(kind, found.task, pull))
    return {
      flag: `task ${id} looks security, authority or merge-policy: register and hold g10-adversary by hand`,
    }
  return {
    register: {
      target,
      task: `${found.initiative}/${id}`,
      implementer,
      kind: SHEPHERD_KINDS[kind] ?? 'unknown',
    },
  }
}

const isAdversaryClass = (kind: string, task: Task, pull: OpenPull): boolean =>
  kind === 'security' ||
  task.tags.some(t => ADVERSARY_WORDS.test(t.replace(/[:_]/g, ' '))) ||
  ADVERSARY_WORDS.test(task.title) ||
  ADVERSARY_WORDS.test(pull.title)

function staleFlag(seat: AdoptSeat, pull: OpenPull, target: ShepherdTarget, ctx: RepoCtx): string[] {
  if (seat.staleDays === undefined) return []
  const idleDays = Math.floor((ctx.now.getTime() - Date.parse(pull.updatedAt)) / DAY_MS)
  if (!(idleDays > seat.staleDays)) return []
  const detail = `idle ${idleDays} days, over stale_pr_days ${seat.staleDays} (${pull.branch.slice(BRANCH_PREFIX.length)})`
  flagOnce(seat.seat, `burndown: ${targetRef(target)} stale`, detail, ctx.ports)
  return []
}

/** One line per key per day: the seat log is daily, so a flag repeats each morning until the PR moves. */
function flagOnce(seat: string, key: string, detail: string, ports: AdoptPorts): void {
  if (ports.logged(seat, key)) return
  ports.append(seat, `${key}: ${detail}`)
}
