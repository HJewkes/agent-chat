import { dirname } from 'node:path'
import { patternsOverlap } from '../../broker/claims.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import type { RefusalKind } from './eligibility.js'
import { run, type Runner } from './exec.js'
import { heldClaims, sameClaim, type Claim, type Ledger, type StackedOn } from './ledger.js'
import { defaultBranch } from './observe.js'
import { exemptFromOverlap, overlapExemptFor } from './overlap-exempt.js'
import { DESTRUCTIVE_OPS, type AcceptedOverlap, type Contract } from './report.js'
import { shepherdTarget } from './shepherd.js'
import { GIT_BIN } from './review-diff.js'

/**
 * The collision check before dispatch (autonomy charter 6.2): work already
 * landed, in an open PR, held by a live agent or a file claim, or touching
 * files an open PR touches. Pure over `CollisionFacts`; the readers below
 * take their `Runner` so a test needs no network. A fact that could not be
 * read refuses, since a miss costs an agent redoing someone's work.
 */

export type CollisionKind = Extract<
  RefusalKind,
  'landed' | 'open-pr' | 'claimed' | 'file-overlap' | 'contract-overlap'
>

export interface Collision {
  kind: CollisionKind
  reason: string
  /** CC-1241: the open PR a `file-overlap` hit names, for the refusal snapshot's blocker. */
  pr?: number
}

export interface CollisionWork {
  taskId: string
  /** A planner slice letter; its parent id lands with each sibling slice's merge, so `landed` skips it. */
  slice?: string
  tags: string[]
  /** The paths a slice declares; empty for a whole task, which skips the file checks. */
  owns: string[]
  /** The scopes a slice declares with an op; omitted means none. */
  contracts?: Contract[]
  /** CC-1158 c: the parent a stacked slice builds on; its PR's files are the child's own base, so file-overlap skips that PR. */
  stackedOn?: StackedOn
  /** CC-1259: open-PR overlaps the planner accepted, each waiving one exact owns path for one PR only. */
  overlapsAccepted?: AcceptedOverlap[]
}

/** A dispatch planned this tick with the work its collision check saw, so a later seat's check sees it too. */
export interface SameTickClaim {
  seat: string
  repo: string
  agentName: string
  work: CollisionWork
}

export interface OpenPr {
  number: number
  title: string
  branch: string
  body: string
}

export interface FileClaim {
  owner: string
  /** The checkout the claim's patterns are relative to: its repo, else its worktree. */
  repo: string
  patterns: string[]
}

/** Everything the check reads about one repo; `undefined` means the read failed. */
export interface CollisionFacts {
  repo: string
  /** Commit subjects on `origin/<default>`, plus one line per body Covers clause; any other body mention is not a landing. */
  subjects: string[] | undefined
  /** The seat's other repos' subjects: a task lands wherever its PR merged, so each counts, and a failed read names its repo. */
  landedElsewhere?: { repo: string; subjects: string[] | undefined }[]
  prs: OpenPr[] | undefined
  prFiles: (pr: number) => string[] | undefined
  /** Live agent and session names on the broker. */
  names: string[] | undefined
  claims: FileClaim[] | undefined
  /** Agents that exited less than one tick ago: the tick may not have seen their PR or branch yet (CC-946). */
  recentlyExited?: string[]
  /** Every agent any claim of this task ever spawned, done claims included: a planner whose claim just went `done` still exited from our own work. */
  lineage?: ReadonlySet<string>
  /** Agents on this task's held claims: a sibling slice's name and branch carry the task ID by design. */
  ours: ReadonlySet<string>
  /** Contracts on held claims other than the work's own, labelled for the refusal reason. */
  held: readonly HeldContracts[]
  /** Owns on dispatched, undone claims other than the work's own: their PRs may not be open yet (CC-952). */
  heldOwns: readonly HeldOwns[]
  /** Agents on dispatched, undone claims with owns: `heldOwns` gates them, so their spawn-time broker claim is stale (CC-1276). */
  burndownAgents?: ReadonlySet<string>
  /** Index and generated files that merge-up resolves at land, so overlap on them alone never refuses (charter 6.2, CC-1153). */
  overlapExempt?: readonly string[]
}

export interface HeldContracts {
  holder: string
  contracts: Contract[]
}

export interface HeldOwns {
  holder: string
  repo: string
  owns: string[]
}

/** `id` as a whole token, any case: TP-40 never matches TP-400, and a branch's `cc-202` matches CC-202. */
export const namesId = (text: string, id: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i').test(text)

export function collision(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  // A file claim is an explicit hold, not a merge-up conflict, so `claimed` keeps the full owns.
  const gated = { ...work, owns: exemptFromOverlap(work.owns, facts.overlapExempt ?? []) }
  return (
    landed(work, facts) ??
    openPr(work, facts) ??
    claimed(work, facts) ??
    fileOverlap(gated, facts) ??
    liveOverlap(gated, facts.repo, facts.heldOwns) ??
    contractOverlap(work, facts.held)
  )
}

const RECONCILED = 'reconciled'

function landed(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  if (work.slice !== undefined || work.tags.some(tag => tag.startsWith(RECONCILED))) return undefined
  const reads = [{ repo: facts.repo, subjects: facts.subjects }, ...(facts.landedElsewhere ?? [])]
  for (const { repo, subjects } of reads) {
    if (subjects === undefined)
      return { kind: 'landed', reason: `reader git-subjects failed: no default-branch subjects in ${repo}` }
  }
  const hit = reads.flatMap(read => read.subjects ?? []).find(subject => namesId(subject, work.taskId))
  if (hit === undefined) return undefined
  return { kind: 'landed', reason: `"${hit}" is on the default branch; reconcile it, then tag it reconciled` }
}

function openPr(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  if (facts.prs === undefined)
    return { kind: 'open-pr', reason: `reader gh-pulls failed: no open PR list for ${facts.repo}` }
  const ourBranches = new Set([...facts.ours].map(name => `${BRANCH_PREFIX}${name}`))
  const hit = facts.prs.find(
    pr =>
      !isReleasePr(pr) &&
      !ourBranches.has(pr.branch) &&
      [pr.title, pr.branch, pr.body].some(text => namesId(text, work.taskId)),
  )
  if (hit === undefined) return undefined
  return { kind: 'open-pr', reason: `#${hit.number} (${hit.branch}) names ${work.taskId}: ${hit.title}` }
}

function claimed(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  if (facts.names === undefined || facts.claims === undefined)
    return { kind: 'claimed', reason: 'reader broker-view failed: no live agents or file claims' }
  const holder = facts.names.find(name => !facts.ours.has(name) && namesId(name, work.taskId))
  if (holder !== undefined) return { kind: 'claimed', reason: `live agent ${holder} carries ${work.taskId}` }
  const gone = (facts.recentlyExited ?? []).find(
    name => !facts.ours.has(name) && !facts.lineage?.has(name) && namesId(name, work.taskId),
  )
  if (gone !== undefined)
    return { kind: 'claimed', reason: `agent ${gone} carrying ${work.taskId} exited less than one tick ago` }
  const foreign = facts.claims.filter(
    c => c.repo === facts.repo && !facts.ours.has(c.owner) && !facts.burndownAgents?.has(c.owner),
  )
  for (const claim of foreign) {
    const path = overlapping(work.owns, claim.patterns)
    if (path !== undefined) return { kind: 'claimed', reason: `${path} is under ${claim.owner}'s file claim` }
  }
  return undefined
}

/** The changesets Version Packages PR's head; it is nearly always open and deletes every pending changeset. */
const RELEASE_BRANCH = 'changeset-release/'

/** Its body copies every pending changeset, so it names tasks it never delivers. */
export const isReleasePr = (pr: Pick<OpenPr, 'branch'>): boolean => pr.branch.startsWith(RELEASE_BRANCH)

/** One changeset file per change, never edited together, so two of them cannot conflict. */
const isChangeset = (path: string): boolean => path.startsWith('.changeset/')

/** Two changeset paths collide only as the same literal file, so a `.changeset/*` owns never holds another task's changeset (CC-1276). */
const pathsCollide = (a: string, b: string): boolean =>
  isChangeset(a) && isChangeset(b) ? a === b : patternsOverlap(a, b)

function fileOverlap(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  const owns = work.owns.filter(path => !isChangeset(path))
  if (owns.length === 0 || facts.prs === undefined) return undefined
  const parentPr = shepherdTarget(work.stackedOn?.pr)?.pr
  for (const pr of facts.prs.filter(pr => !isReleasePr(pr) && pr.number !== parentPr)) {
    const files = facts.prFiles(pr.number)
    if (files === undefined)
      return { kind: 'file-overlap', reason: `reader gh-pull-files failed: no file list for #${pr.number}` }
    const path = overlapping(
      owns.filter(own => !accepted(work, pr.number, own)),
      files.filter(path => !isChangeset(path)),
    )
    if (path !== undefined)
      return { kind: 'file-overlap', reason: `#${pr.number} touches ${path}`, pr: pr.number }
  }
  return undefined
}

const accepted = (work: CollisionWork, pr: number, path: string): boolean =>
  (work.overlapsAccepted ?? []).some(a => a.pr === pr && a.path === path)

/** Also the same-pass check: a seat passes the dispatches it has already accepted this pass as `held`. */
export function liveOverlap(
  work: CollisionWork,
  repo: string,
  held: readonly HeldOwns[],
): Collision | undefined {
  for (const other of held.filter(h => h.repo === repo)) {
    const path = overlapping(work.owns, other.owns)
    if (path !== undefined) return { kind: 'file-overlap', reason: `${path} is under ${other.holder}'s owns` }
  }
  return undefined
}

const isDestructive = (contract: Contract): boolean => DESTRUCTIVE_OPS.includes(contract.op)

/** The first exact-scope pair (byte-equal, no folding) where either side's op is destructive. */
export function contractClash(
  ours: readonly Contract[] = [],
  theirs: readonly Contract[] = [],
): { ours: Contract; theirs: Contract } | undefined {
  for (const ourContract of ours) {
    const theirContract = theirs.find(
      t => t.scope === ourContract.scope && (isDestructive(ourContract) || isDestructive(t)),
    )
    if (theirContract !== undefined) return { ours: ourContract, theirs: theirContract }
  }
  return undefined
}

/** Also the same-pass check: a planner passes the dispatches it has already accepted this tick as `held`. */
export function contractOverlap(work: CollisionWork, held: readonly HeldContracts[]): Collision | undefined {
  for (const other of held) {
    const clash = contractClash(work.contracts, other.contracts)
    if (clash !== undefined) return { kind: 'contract-overlap', reason: clashReason(clash, other.holder) }
  }
  return undefined
}

const clashReason = (clash: { ours: Contract; theirs: Contract }, holder: string): string =>
  `${clash.ours.scope} is declared ${clash.ours.op} here and ${clash.theirs.op} by ${holder}`

/** Another seat's dispatch this tick, which no reader below can see yet: the same task, or an overlapping declared path. */
export function sameTickCollision(
  earlier: readonly SameTickClaim[],
  repo: string,
  work: CollisionWork,
): Collision | undefined {
  const task = earlier.find(c => c.work.taskId === work.taskId)
  if (task !== undefined)
    return {
      kind: 'claimed',
      reason: `seat ${task.seat} dispatched it earlier this tick as ${task.agentName}`,
    }
  for (const claim of earlier.filter(c => c.repo === repo)) {
    const path = overlapping(work.owns, claim.work.owns)
    if (path !== undefined)
      return {
        kind: 'claimed',
        reason: `${path} is under ${claim.agentName}'s owns, dispatched by seat ${claim.seat} earlier this tick`,
      }
  }
  for (const claim of earlier) {
    const clash = contractClash(work.contracts, claim.work.contracts)
    if (clash !== undefined)
      return {
        kind: 'contract-overlap',
        reason: `${clashReason(clash, claim.agentName)}, dispatched by seat ${claim.seat} earlier this tick`,
      }
  }
  return undefined
}

const overlapping = (owns: string[], others: string[]): string | undefined =>
  owns.find(own => others.some(other => pathsCollide(own, other)))

const TASK_ID = '[A-Za-z][A-Za-z0-9]*-\\d+'
const ID_SEPARATOR = '[ \\t]*(?:,[ \\t]*(?:and[ \\t]+)?|and[ \\t]+|&[ \\t]*)'
// A clause opens a line, a list bullet or a sentence, so "Partly covers" and "This covers" stay prose.
const COVERS_CLAUSE = new RegExp(
  `(?:^[ \\t]*(?:[-*][ \\t]+)?|\\.[ \\t]+)(?:Also covers|Covers):?[ \\t]+(${TASK_ID}(?:${ID_SEPARATOR}${TASK_ID})*)`,
  'gm',
)

/** Ids a body lists in a `Covers` or `Also covers` clause (CC-1068): a PR that says so delivers them too. */
export function coveredIds(body: string): string[] {
  const ids = [...body.matchAll(COVERS_CLAUSE)].flatMap(
    clause => (clause[1] ?? '').match(new RegExp(TASK_ID, 'g')) ?? [],
  )
  return [...new Set(ids)]
}

/** The format `landingLines` parses: subject, unit separator, body, record separator. */
export const LANDING_LOG_FORMAT = '--format=%s%x1f%b%x1e'

/** Each commit's subject, then `<subject> [covers <ids>]` when its body has a Covers clause. */
export function landingLines(log: string): string[] {
  return log.split('\x1e').flatMap(record => {
    const [head = '', body = ''] = record.split('\x1f')
    const subject = head.trim()
    if (subject.length === 0) return []
    const covered = coveredIds(body)
    return covered.length === 0 ? [subject] : [subject, `${subject} [covers ${covered.join(', ')}]`]
  })
}

/** Subjects and Covers clauses on `origin/<branch>`, fetched first so a landing since the last fetch counts. */
export function readSubjects(repo: string, branch: string, exec: Runner = run): string[] | undefined {
  if (exec(GIT_BIN, ['fetch', '--quiet', '--no-tags', 'origin', branch], repo).status !== 0) return undefined
  const result = exec(GIT_BIN, ['log', `origin/${branch}`, LANDING_LOG_FORMAT], repo)
  return result.status === 0 ? landingLines(result.stdout) : undefined
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits. `{owner}/{repo}` resolves from `cwd`.
const PULLS = 'repos/{owner}/{repo}/pulls'

export function readOpenPrs(repo: string, exec: Runner = run): OpenPr[] | undefined {
  const jq = '.[] | {number, title, branch: .head.ref, body: (.body // "")}'
  const result = exec('gh', ['api', '--paginate', `${PULLS}?state=open&per_page=100`, '--jq', jq], repo)
  if (result.status !== 0) return undefined
  try {
    return jsonLines(result.stdout) as OpenPr[]
  } catch {
    return undefined
  }
}

const FILES_JQ = '.[] | {filename, previous: (.previous_filename // null)}'

/**
 * Every path the PR touches. A rename yields its old path too, so a PR that moves a file still collides with work
 * on that file (CC-1150 f); a line that does not parse makes the whole list unreadable rather than short.
 */
export function readPrFiles(repo: string, pr: number, exec: Runner = run): string[] | undefined {
  const args = ['api', '--paginate', `${PULLS}/${pr}/files?per_page=100`, '--jq', FILES_JQ]
  const result = exec('gh', args, repo)
  if (result.status !== 0) return undefined
  try {
    return jsonLines(result.stdout).flatMap(changedPaths)
  } catch {
    return undefined
  }
}

function changedPaths(line: unknown): string[] {
  const { filename, previous } = (line ?? {}) as { filename?: unknown; previous?: unknown }
  if (typeof filename !== 'string') throw new Error('PR file line without a filename')
  return typeof previous === 'string' ? [previous, filename] : [filename]
}

const jsonLines = (text: string): unknown[] =>
  text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as unknown)

/** What the broker says is live: agent and session names, and every `files` claim. */
export interface BrokerView {
  names: string[]
  claims: FileClaim[]
  /** Names of agents that exited less than one tick ago. */
  recentlyExited?: string[]
}

/** The four readers a refusal reason names when its fact could not be read. */
export type CollisionReader = 'git-subjects' | 'gh-pulls' | 'gh-pull-files' | 'broker-view'

export type ReaderFailed = (reader: CollisionReader, repo: string, detail?: string) => void

/** The check `plan` takes, reading each repo's facts once; `broker` undefined means it could not be reached. */
export function collisionCheck(
  ledger: Ledger,
  broker: BrokerView | undefined,
  exec: Runner = run,
  failed: ReaderFailed = () => {},
  exemptFor: (repo: string) => string[] = overlapExemptFor,
): (repo: string, work: CollisionWork, landedRepos?: readonly string[]) => Collision | undefined {
  const perRepo = new Map<string, CollisionFacts>()
  const perSubjects = new Map<string, string[] | undefined>()
  const subjectsOf = (repo: string): string[] | undefined => {
    if (perSubjects.has(repo)) return perSubjects.get(repo)
    const read = readSubjects(repo, defaultBranch(repo, exec), exec)
    perSubjects.set(repo, read)
    if (read === undefined) failed('git-subjects', repo)
    return read
  }
  return (repo, work, landedRepos = []) => {
    const facts =
      perRepo.get(repo) ?? readFacts(repo, broker, exec, failed, subjectsOf(repo), exemptFor(repo))
    perRepo.set(repo, facts)
    return collision(work, {
      ...facts,
      landedElsewhere: landedRepos
        .filter(other => other !== repo)
        .map(other => ({ repo: other, subjects: subjectsOf(other) })),
      ours: oursFor(ledger, work.taskId),
      lineage: lineageOf(ledger, work.taskId),
      held: heldContracts(ledger, work),
      heldOwns: heldOwns(ledger, work),
      burndownAgents: heldAgents(ledger),
    })
  }
}

/** One repo's facts, reporting each reader that fails once, so the caller can log it by name. */
function readFacts(
  repo: string,
  broker: BrokerView | undefined,
  exec: Runner,
  failed: ReaderFailed,
  subjects: string[] | undefined,
  overlapExempt: string[],
): CollisionFacts {
  const prs = readOpenPrs(repo, exec)
  if (prs === undefined) failed('gh-pulls', repo)
  if (broker === undefined) failed('broker-view', repo)
  const files = new Map<number, string[] | undefined>()
  const prFiles = (pr: number): string[] | undefined => {
    if (files.has(pr)) return files.get(pr)
    const read = readPrFiles(repo, pr, exec)
    files.set(pr, read)
    if (read === undefined) failed('gh-pull-files', repo, `#${pr}`)
    return read
  }
  return {
    repo,
    subjects,
    prs,
    prFiles,
    names: broker?.names,
    claims: broker?.claims,
    ...(broker?.recentlyExited === undefined ? {} : { recentlyExited: broker.recentlyExited }),
    ours: new Set(),
    held: [],
    heldOwns: [],
    overlapExempt,
  }
}

/** A done claim's agents and PR are not ours any more: a re-pick must see them as someone else's. */
const oursFor = (ledger: Ledger, taskId: string): ReadonlySet<string> =>
  new Set(
    heldClaims(ledger)
      .filter(c => c.taskId === taskId)
      .flatMap(c => [...(c.spawned ?? []), ...(c.agentName === undefined ? [] : [c.agentName])]),
  )

/** Includes `done` claims, since a retire may not have run when the exit is read. */
const lineageOf = (ledger: Ledger, taskId: string): ReadonlySet<string> =>
  new Set(
    ledger.claims
      .filter(c => c.taskId === taskId)
      .flatMap(c => [...(c.spawned ?? []), ...(c.agentName === undefined ? [] : [c.agentName])]),
  )

const holderOf = (c: Pick<Claim, 'taskId' | 'slice'>): string =>
  `${c.taskId}${c.slice === undefined ? '' : ` slice ${c.slice}`}`

/**
 * Every dispatched, undone claim with contracts except the work's own; a sibling slice of the same task still
 * counts. A queued claim holds nothing yet: counting it would let two queued claims refuse each other forever.
 */
const heldContracts = (ledger: Ledger, work: CollisionWork): HeldContracts[] =>
  heldClaims(ledger)
    .filter(c => c.phase !== 'queued' && !sameClaim(c, work) && (c.contracts ?? []).length > 0)
    .map(c => ({
      holder: holderOf(c),
      contracts: c.contracts ?? [],
    }))

/** A claim's repo is its worktree's (`<repo>/.worktrees/<name>`), else the plan's. */
const claimRepo = (c: Claim): string | undefined =>
  c.worktree === undefined ? c.repo : dirname(dirname(c.worktree))

/** A dispatched claim whose owns `liveOverlap` can gate. */
const holdsOwns = (c: Claim): boolean =>
  c.phase !== 'queued' && (c.owns ?? []).length > 0 && claimRepo(c) !== undefined

/** As `heldContracts`, for owns. */
const heldOwns = (ledger: Ledger, work: CollisionWork): HeldOwns[] =>
  heldClaims(ledger).flatMap(c => {
    const repo = claimRepo(c)
    if (!holdsOwns(c) || sameClaim(c, work) || repo === undefined) return []
    return [{ holder: holderOf(c), repo, owns: c.owns ?? [] }]
  })

/** The agents of every claim `heldOwns` reports; the work's own claim is left in, since `ours` skips it anyway. */
const heldAgents = (ledger: Ledger): ReadonlySet<string> =>
  new Set(
    heldClaims(ledger)
      .filter(holdsOwns)
      .flatMap(c => [...(c.spawned ?? []), ...(c.agentName === undefined ? [] : [c.agentName])]),
  )
