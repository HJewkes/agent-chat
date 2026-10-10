import { BRANCH_PREFIX } from '../isolation/worktree.js'
import type { Task } from './eligibility.js'
import { holdReasonRefusal } from './hold-reason.js'
import type { OwedHold } from './owed-holds.js'
import {
  targetRef,
  type Registration,
  type RegisterReply,
  type ShepherdKind,
  type ShepherdListing,
  type ShepherdTarget,
} from './shepherd.js'

/**
 * CC-861: each tick, register a seat's open PRs that Shepherd does not list, which
 * the coordinator did by hand after every DONE report. It registers only what it
 * can prove ordinary: a correctness, bug, feature, platform, product, agent-tooling or refactor task
 * whose every changed path is on an allow-list of tests, docs and changesets, and whose diff
 * is G10-small. CC-931: a sensitive word in its title or tags registers the PR and then holds
 * the run under the g10-review class, naming the word and task, for the seat to release. A reason
 * Shepherd's hold check would refuse is flagged before anything registers. A hold that fails for a
 * passing reason (Shepherd down) is owed: each later tick retries it until Shepherd takes it or no
 * longer lists the run, and the seat is flagged once a day meanwhile. A hold Shepherd refuses is never
 * retried: the seat is flagged that the run is live and unheld. Shepherd holds only a run that
 * exists, so a seconds-wide window between the two calls stays open until Shepherd applies a
 * hold class at registration; until then a `secur` word is still only flagged. Everything else is
 * flagged in the seat's log, for the seat to register and hold by hand. Shepherd down is
 * logged and retried next tick; registration never goes `--offline`.
 */

export interface OpenPull {
  number: number
  title: string
  branch: string
  /** `owner/name` of the head's repo; a fork's differs from the base. */
  headRepo: string
  updatedAt: string
}

export interface ChangedFile {
  path: string
  /** A rename's old path, which must be ordinary too: moving a guard into `__tests__/` changes the guard. */
  previousPath?: string
  additions: number
  deletions: number
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
  /** The PR's changed files, read over REST; undefined when the read failed. */
  files: (target: ShepherdTarget) => ChangedFile[] | undefined
  task: (initiatives: readonly string[], id: string) => { initiative: string; task: Task } | undefined
  /** What Shepherd lists, malformed and branch-only rows included; undefined when serve did not answer. */
  listed: () => ShepherdListing | undefined
  /** `shepherd register` without a listing first. */
  register: (reg: Registration) => RegisterReply
  /** `shepherd hold` on a registered run, with the reason the seat reads. */
  hold: (target: ShepherdTarget, reason: string) => RegisterReply
  /** Holds a past tick registered a run for and could not place. */
  owedHolds: () => OwedHold[]
  setOwedHolds: (holds: readonly OwedHold[]) => void
  /** Whether today's seat log already has a line containing `key`. */
  logged: (seat: string, key: string) => boolean
  append: (seat: string, text: string) => void
  log: (event: string, detail: Record<string, unknown>) => void
}

/** Charter G10: a diff over this many changed lines is held for Shepherd's opus review. */
export const G10_DIFF_LINES = 400

/** The most PRs one seat registers in a tick; the rest wait for the next. */
export const REGISTERS_PER_SEAT = 3

const DAY_MS = 86_400_000

const SHEPHERD_KINDS: Readonly<Record<string, ShepherdKind>> = {
  correctness: 'correctness',
  bug: 'correctness',
  feature: 'feature',
  platform: 'feature',
  product: 'feature',
  'agent-tooling': 'feature',
  refactor: 'refactor',
}

/**
 * Stems in a title or tag that may mean authority, merge policy, a guard or provenance;
 * matched from a word start, so `auth` also catches authentication and authorization.
 */
const SENSITIVE_STEMS = [
  'secur',
  'auth',
  'permi',
  'polic',
  'trust',
  'grant',
  'secret',
  'credential',
  'guard',
  'egress',
  'merge',
  'gate',
  'owner[- ]?presence',
  'proof',
  'allow[- ]?list',
  'den(y|ie)',
  'bypass',
  'sandbox',
  'token',
  'approv',
  'endors',
  'provenance',
  'hook',
  'identit',
  'escalat',
  'privileg',
]

/** Captures the whole word from the stem on, so a seat reads "authority" rather than "auth". */
const SENSITIVE_TEXT = new RegExp(`\\b((?:${SENSITIVE_STEMS.join('|')})\\w*)`, 'gi')

/**
 * Words still only flagged: their hold needs Shepherd to apply a hold class at registration (N1),
 * not after it. Matched anywhere, since one captured word can join stems: `authSecurity`.
 */
const FLAG_ONLY_WORD = /secur/i

/** The only paths a registered PR may change: tests, docs and changesets, which grant nothing. Anything else is flagged. */
const ORDINARY_PATHS = [
  /(^|\/)__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /^docs\//,
  /^site\//,
  /^\.changeset\/[^/]+\.md$/,
  /(^|\/)(README|CHANGELOG)\.md$/i,
]

const isOrdinaryPath = (p: string): boolean => ORDINARY_PATHS.some(re => re.test(p))

/** `hold` is the reason a registered run is held at once; absent, the run goes ahead. */
type Verdict = { flag: string } | { register: Registration; hold?: string }

/** Registers or flags each seat's unregistered PRs; returns the tick's lines. */
export function adoptSeatPrs(
  seats: readonly AdoptSeat[],
  claimed: ReadonlySet<string>,
  ports: AdoptPorts,
  now: Date,
): string[] {
  if (seats.length === 0) return []
  const listed = ports.listed()
  if (listed === undefined) {
    ports.log('burndown_pr_adopt_shepherd_down', {})
    return ['shepherd did not answer; seat PR adoption retries next tick']
  }
  settleOwedHolds(listed, ports)
  const ctx = { listed, claimed, ports, now }
  return seats.flatMap(seat => {
    const budget = { left: REGISTERS_PER_SEAT }
    return seat.repos.flatMap(repo => {
      const slug = ports.repoOf(repo.checkout)
      return slug === undefined ? [] : adoptRepo(seat, slug, repo.initiatives, { ...ctx, budget })
    })
  })
}

interface RepoCtx {
  listed: ShepherdListing
  claimed: ReadonlySet<string>
  ports: AdoptPorts
  now: Date
  /** Registrations this seat may still make this tick. */
  budget: { left: number }
}

/**
 * The seat's own PRs: its branch prefix, pushed to this repo and not a fork, neither
 * claimed nor listed by number or branch. A register would find a branch-only run
 * by its branch and overwrite its task, implementer and policy.
 */
function unregisteredPulls(seat: AdoptSeat, repo: string, pulls: OpenPull[], ctx: RepoCtx): OpenPull[] {
  const own = `${BRANCH_PREFIX}${seat.prefix}-`
  return pulls.filter(p => {
    const ref = targetRef({ repo, pr: p.number }).toLowerCase()
    return (
      p.branch.startsWith(own) &&
      p.headRepo.toLowerCase() === repo.toLowerCase() &&
      !ctx.listed.prs.has(ref) &&
      !ctx.listed.branches.has(p.branch) &&
      !ctx.claimed.has(ref)
    )
  })
}

function adoptRepo(seat: AdoptSeat, repo: string, initiatives: string[], ctx: RepoCtx): string[] {
  const pulls = ctx.ports.pulls(repo)
  if (pulls === undefined) {
    ctx.ports.log('burndown_pr_adopt_read_failed', { seat: seat.seat, repo })
    return []
  }
  return unregisteredPulls(seat, repo, pulls, ctx).flatMap(pull => {
    const target = { repo, pr: pull.number }
    if (ctx.budget.left <= 0) return staleFlag(seat, pull, target, ctx)
    const adopted = adoptPull(seat, pull, target, initiatives, ctx)
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
  ctx: RepoCtx,
): boolean {
  const { ports } = ctx
  const files = ports.files(target)
  if (files === undefined) {
    ports.log('burndown_pr_adopt_files_unread', { seat: seat.seat, target: targetRef(target) })
    return false
  }
  const verdict = classify(pull, target, files, initiatives, ports)
  if ('flag' in verdict) {
    flagOnce(seat.seat, `burndown: ${targetRef(target)} unregistered`, verdict.flag, ports)
    return false
  }
  ctx.budget.left -= 1
  if (!registerOnce(seat, verdict.register, ports)) return false
  if (verdict.hold === undefined) return true
  const owed = { seat: seat.seat, ...verdict.register.target, reason: verdict.hold }
  if (holdRun(owed, ports) === 'owed') ports.setOwedHolds([...ports.owedHolds(), owed])
  return true
}

/** `owed` is a hold to retry next tick; a refused hold is settled, since Shepherd will refuse it again. */
type HoldOutcome = 'held' | 'owed' | 'refused'

/**
 * Retries every owed hold. A run Shepherd no longer lists is not registered, so its hold is
 * dropped; a refused hold is dropped and flagged; any other failure stays owed, because the run
 * is live and unheld.
 */
function settleOwedHolds(listed: ShepherdListing, ports: AdoptPorts): void {
  const owed = ports.owedHolds()
  if (owed.length === 0) return
  const still = owed.filter(h => listed.prs.has(targetRef(h).toLowerCase()) && holdRun(h, ports) === 'owed')
  if (still.length !== owed.length) ports.setOwedHolds(still)
}

/** Anything but `held` leaves the run live and unheld, and the seat is flagged once a day. */
function holdRun(owed: OwedHold, ports: AdoptPorts): HoldOutcome {
  const ref = targetRef(owed)
  const reply = ports.hold(owed, owed.reason)
  if (reply.ok) {
    ports.log('burndown_pr_adopt_held', { seat: owed.seat, target: ref, reason: owed.reason })
    return 'held'
  }
  if (reply.refused) {
    ports.log('burndown_pr_adopt_hold_refused', { seat: owed.seat, target: ref, reason: reply.reason })
    flagOnce(
      owed.seat,
      `burndown: ${ref} unheld sensitive run`,
      `registered, but Shepherd refused the hold (${reply.reason}) and the tick will not retry it; hold it by hand now: ${owed.reason}`,
      ports,
    )
    return 'refused'
  }
  ports.log('burndown_pr_adopt_hold_failed', { seat: owed.seat, target: ref, reason: reply.reason })
  flagOnce(
    owed.seat,
    `burndown: ${ref} not held`,
    `registered, but the hold failed (${reply.reason}); the tick retries it, or hold it by hand: ${owed.reason}`,
    ports,
  )
  return 'owed'
}

function registerOnce(seat: AdoptSeat, reg: Registration, ports: AdoptPorts): boolean {
  const reply = ports.register(reg)
  if (reply.ok) return true
  const ref = targetRef(reg.target)
  ports.log('burndown_pr_adopt_register_failed', { seat: seat.seat, target: ref, reason: reply.reason })
  if (reply.refused) flagOnce(seat.seat, `burndown: ${ref} refused`, `by Shepherd: ${reply.reason}`, ports)
  return false
}

/** The registration, or why the seat must decide. Unknown is never ordinary. */
function classify(
  pull: OpenPull,
  target: ShepherdTarget,
  files: readonly ChangedFile[],
  initiatives: readonly string[],
  ports: AdoptPorts,
): Verdict {
  const implementer = pull.branch.slice(BRANCH_PREFIX.length)
  const id = /^[a-z0-9]+-([a-z]+-\d+)/.exec(implementer)?.[1]?.toUpperCase()
  if (id === undefined) return { flag: `no task id in branch ${pull.branch}` }
  const found = ports.task(initiatives, id)
  if (found === undefined) return { flag: `task ${id} not found in the seat's initiatives` }
  const kind = found.task.tags.find(t => t.startsWith('kind:'))?.slice('kind:'.length) ?? ''
  const shepherdKind = SHEPHERD_KINDS[kind]
  if (shepherdKind === undefined) return { flag: `task ${id} kind "${kind}" is not one the tick registers` }
  const word = sensitiveWord(found.task, pull)
  const hit =
    word !== undefined && FLAG_ONLY_WORD.test(word) ? `sensitive word "${word}"` : unordinaryPath(files)
  if (hit !== undefined) return { flag: `${hit}: register it by hand (${id})` }
  const added = files.reduce((n, f) => n + f.additions, 0)
  const deleted = files.reduce((n, f) => n + f.deletions, 0)
  if (added + deleted > G10_DIFF_LINES)
    return {
      flag: `diff +${added}/-${deleted} over ${G10_DIFF_LINES}: register and hold g10-review by hand (${id})`,
    }
  const register = { target, task: `${found.initiative}/${id}`, implementer, kind: shepherdKind }
  if (word === undefined) return { register }
  const hold = sensitiveHoldReason(word, id)
  const refusal = holdReasonRefusal(hold)
  if (refusal !== undefined)
    return {
      flag: `sensitive word "${word}", and Shepherd would refuse its hold (${refusal}): register and hold it by hand (${id})`,
    }
  return { register, hold }
}

/**
 * g10-review, so the run waits for an opus G10 review that Shepherd's g10 release reads by class.
 * Words are only letters, digits and `_`, so neither a ":" nor a ";" from the title can reach the class.
 */
function sensitiveHoldReason(word: string, id: string): string {
  return `g10-review: sensitive word "${word}"; ${id}`
}

/** A flag-only word wins wherever it sits, so an earlier held word cannot carry it past the seat. */
function sensitiveWord(task: Task, pull: OpenPull): string | undefined {
  const texts = [task.title, pull.title, ...task.tags.map(t => t.replace(/[:_]/g, ' '))]
  const words = texts.flatMap(t => [...t.matchAll(SENSITIVE_TEXT)].map(m => m[1] as string))
  return words.find(w => FLAG_ONLY_WORD.test(w)) ?? words[0]
}

function unordinaryPath(files: readonly ChangedFile[]): string | undefined {
  const other = files
    .flatMap(f => (f.previousPath === undefined ? [f.path] : [f.previousPath, f.path]))
    .find(p => !isOrdinaryPath(p))
  return other === undefined ? undefined : `path ${other} is not a test or doc`
}

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
