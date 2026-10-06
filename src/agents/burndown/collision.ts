import { patternsOverlap } from '../../broker/claims.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import type { RefusalKind } from './eligibility.js'
import { run, type Runner } from './exec.js'
import { heldClaims, sameClaim, type Ledger } from './ledger.js'
import { defaultBranch } from './observe.js'
import { DESTRUCTIVE_OPS, type Contract } from './report.js'
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
  /** Commit subjects on `origin/<default>`, never bodies: a body mention is not a landing. */
  subjects: string[] | undefined
  /** The seat's other repos' subjects: a task lands wherever its PR merged, so each counts, and a failed read names its repo. */
  landedElsewhere?: { repo: string; subjects: string[] | undefined }[]
  prs: OpenPr[] | undefined
  prFiles: (pr: number) => string[] | undefined
  /** Live agent and session names on the broker. */
  names: string[] | undefined
  claims: FileClaim[] | undefined
  /** Agents on this task's held claims: a sibling slice's name and branch carry the task ID by design. */
  ours: ReadonlySet<string>
  /** Contracts on held claims other than the work's own, labelled for the refusal reason. */
  held: readonly HeldContracts[]
}

export interface HeldContracts {
  holder: string
  contracts: Contract[]
}

/** `id` as a whole token, any case: TP-40 never matches TP-400, and a branch's `cc-202` matches CC-202. */
export const namesId = (text: string, id: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i').test(text)

export function collision(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  return (
    landed(work, facts) ??
    openPr(work, facts) ??
    claimed(work, facts) ??
    fileOverlap(work, facts) ??
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
      !ourBranches.has(pr.branch) && [pr.title, pr.branch, pr.body].some(text => namesId(text, work.taskId)),
  )
  if (hit === undefined) return undefined
  return { kind: 'open-pr', reason: `#${hit.number} (${hit.branch}) names ${work.taskId}: ${hit.title}` }
}

function claimed(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  if (facts.names === undefined || facts.claims === undefined)
    return { kind: 'claimed', reason: 'reader broker-view failed: no live agents or file claims' }
  const holder = facts.names.find(name => !facts.ours.has(name) && namesId(name, work.taskId))
  if (holder !== undefined) return { kind: 'claimed', reason: `live agent ${holder} carries ${work.taskId}` }
  for (const claim of facts.claims.filter(c => c.repo === facts.repo && !facts.ours.has(c.owner))) {
    const path = overlapping(work.owns, claim.patterns)
    if (path !== undefined) return { kind: 'claimed', reason: `${path} is under ${claim.owner}'s file claim` }
  }
  return undefined
}

function fileOverlap(work: CollisionWork, facts: CollisionFacts): Collision | undefined {
  if (work.owns.length === 0 || facts.prs === undefined) return undefined
  for (const pr of facts.prs) {
    const files = facts.prFiles(pr.number)
    if (files === undefined)
      return { kind: 'file-overlap', reason: `reader gh-pull-files failed: no file list for #${pr.number}` }
    const path = overlapping(work.owns, files)
    if (path !== undefined) return { kind: 'file-overlap', reason: `#${pr.number} touches ${path}` }
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
  owns.find(own => others.some(other => patternsOverlap(own, other)))

/** Subjects only (`%s`) on `origin/<branch>`, fetched first so a landing since the last fetch counts. */
export function readSubjects(repo: string, branch: string, exec: Runner = run): string[] | undefined {
  if (exec(GIT_BIN, ['fetch', '--quiet', '--no-tags', 'origin', branch], repo).status !== 0) return undefined
  const result = exec(GIT_BIN, ['log', `origin/${branch}`, '--format=%s'], repo)
  return result.status === 0 ? result.stdout.split('\n').filter(line => line.length > 0) : undefined
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

export function readPrFiles(repo: string, pr: number, exec: Runner = run): string[] | undefined {
  const args = ['api', '--paginate', `${PULLS}/${pr}/files?per_page=100`, '--jq', '.[].filename']
  const result = exec('gh', args, repo)
  return result.status === 0 ? result.stdout.split('\n').filter(line => line.length > 0) : undefined
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
    const facts = perRepo.get(repo) ?? readFacts(repo, broker, exec, failed, subjectsOf(repo))
    perRepo.set(repo, facts)
    return collision(work, {
      ...facts,
      landedElsewhere: landedRepos
        .filter(other => other !== repo)
        .map(other => ({ repo: other, subjects: subjectsOf(other) })),
      ours: oursFor(ledger, work.taskId),
      held: heldContracts(ledger, work),
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
    ours: new Set(),
    held: [],
  }
}

/** A done claim's agents and PR are not ours any more: a re-pick must see them as someone else's. */
const oursFor = (ledger: Ledger, taskId: string): ReadonlySet<string> =>
  new Set(
    heldClaims(ledger)
      .filter(c => c.taskId === taskId)
      .flatMap(c => [...(c.spawned ?? []), ...(c.agentName === undefined ? [] : [c.agentName])]),
  )

/**
 * Every dispatched, undone claim with contracts except the work's own; a sibling slice of the same task still
 * counts. A queued claim holds nothing yet: counting it would let two queued claims refuse each other forever.
 */
const heldContracts = (ledger: Ledger, work: CollisionWork): HeldContracts[] =>
  heldClaims(ledger)
    .filter(c => c.phase !== 'queued' && !sameClaim(c, work) && (c.contracts ?? []).length > 0)
    .map(c => ({
      holder: `${c.taskId}${c.slice === undefined ? '' : ` slice ${c.slice}`}`,
      contracts: c.contracts ?? [],
    }))
