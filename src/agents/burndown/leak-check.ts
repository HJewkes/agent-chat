import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EMPTY_DENYLIST, loadDenylist, type DenylistLoad } from '../../leak-guard/denylist.js'
import { gitRangeSource } from '../../leak-guard/git-source.js'
import {
  buildMatchers,
  redactText,
  scanRange,
  scanText,
  type Finding,
  type RangeSource,
  type ScanContext,
} from '../../leak-guard/scan.js'
import { denylistPath } from '../../paths.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import type { Runner } from './exec.js'
import { heldClaims, type Claim, type Ledger } from './ledger.js'
import type { HumanItem } from './seat-deliver.js'
import { GIT_BIN } from './review-diff.js'

/**
 * The tick's leak backstop (CC-265 S3): scan the open PRs of every repo the ledger has a PR in.
 * A claim's finding becomes its seat's `leak` event; any other agent PR's goes to the human queue.
 * It reads PRs over REST only and never edits or closes one. Findings carry location and category, never text.
 */

export interface LeakDeps {
  exec: Runner
  log: (event: string, detail: Record<string, unknown>) => void
  /** Seats the tick tells; a claim of any other seat, or of none, goes to the human queue. */
  seats: readonly string[]
  home?: string
  denylist?: DenylistLoad
  /** Reads a checkout's commits for the pushed-branch scan; a test injects one. */
  source?: (cwd: string) => RangeSource
}

export interface LeakResult {
  ledger: Ledger
  human: HumanItem[]
  lines: string[]
}

interface Pull {
  number: number
  url: string
  title: string
  body: string
  branch: string
  /** `owner/name` of the head's repo; a fork's differs from the base, and a deleted fork's is empty. */
  headRepo: string
  base: string
  private: boolean
}

/** Why a PR list could not be read: the HTTP status when gh reported one, so a 403 is told apart from a rate limit. */
interface ReadFailure {
  exit: number | null
  http?: number
  rateLimited: boolean
}

/** The rows kept per claim or PR; the rest are counted, so one seat message stays readable. */
const SHOWN_FINDINGS = 8

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/

export const repoOfPr = (url: string): string | undefined => {
  const m = PR_URL.exec(url)
  return m === null ? undefined : `${m[1]}/${m[2]}`
}

const PULL_JQ =
  '.[] | {number, url: .html_url, title, body: (.body // ""), branch: .head.ref, headRepo: (.head.repo.full_name // ""), base: .base.ref, private: (.base.repo.private // false)}'

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
export function readPulls(repo: string, exec: Runner): Pull[] | ReadFailure {
  const args = ['api', '--paginate', `repos/${repo}/pulls?state=open&per_page=100`, '--jq', PULL_JQ]
  const result = exec('gh', args)
  if (result.status !== 0) return readFailure(result.status, result.stderr ?? '')
  try {
    return result.stdout
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Pull)
  } catch {
    return { exit: result.status, rateLimited: false }
  }
}

function readFailure(exit: number | null, stderr: string): ReadFailure {
  const http = /\bHTTP (\d{3})\b/.exec(stderr)?.[1]
  return {
    exit,
    ...(http === undefined ? {} : { http: Number(http) }),
    rateLimited: /rate limit/i.test(stderr),
  }
}

export async function leakCheck(ledger: Ledger, deps: LeakDeps): Promise<LeakResult> {
  const repos = reposOf(ledger)
  if (repos.length === 0) return { ledger, human: [], lines: [] }
  const load = deps.denylist ?? loadDenylist(denylistPath())
  const list = load.kind === 'ok' ? load.list : EMPTY_DENYLIST
  const pass: Pass = {
    ctx: { list, home: deps.home ?? os.homedir() },
    deps,
    ledger: recordDenylist(ledger, load.kind, deps),
    human: [],
    lines: [],
    current: new Set(),
    read: new Set(),
  }
  for (const repo of repos) await checkRepo(pass, repo)
  return { ledger: pruneFiled(pass.ledger, pass.current, pass.read), human: pass.human, lines: pass.lines }
}

/** One tick's running state across repos. */
interface Pass {
  ctx: ScanContext
  deps: LeakDeps
  ledger: Ledger
  human: HumanItem[]
  lines: string[]
  /** Keys of every human item whose finding holds this tick, filed or not. */
  current: Set<string>
  /** Repos whose open PRs were read this tick. */
  read: Set<string>
}

/** One PR's findings for a seated claim; a claim collects every PR it owns before its record is compared. */
interface PrRows {
  number: number
  url: string
  rows: string[]
}

type Found = Map<Claim, PrRows[]>

const reposOf = (ledger: Ledger): string[] => [
  ...new Set(heldClaims(ledger).flatMap(c => repoOfPr(c.pr ?? '') ?? [])),
]

/** A fork's head ref is chosen by whoever opened it, so it never stands for an agent's branch. */
const fromBaseRepo = (pull: Pull, repo: string): boolean => pull.headRepo.toLowerCase() === repo.toLowerCase()

async function checkRepo(pass: Pass, repo: string): Promise<void> {
  const pulls = readPulls(repo, pass.deps.exec)
  if (!Array.isArray(pulls)) return readFailed(pass, repo, pulls)
  pass.read.add(repo)
  const found: Found = new Map()
  for (const pull of pulls.filter(p => fromBaseRepo(p, repo))) await checkPull(pass, pull, found)
  pass.ledger = settleClaims(pass.ledger, repo, found)
}

function readFailed(pass: Pass, repo: string, failure: ReadFailure): void {
  pass.deps.log('burndown_leak_reader_failed', { repo, ...failure })
  const why = [
    failure.http === undefined ? `exit ${failure.exit ?? 'none'}` : `HTTP ${failure.http}`,
    ...(failure.rateLimited ? ['rate limited'] : []),
  ].join(', ')
  const shown = redactText(repo, buildMatchers(pass.ctx))
  pass.lines.push(`leak check could not list open PRs of ${shown} (${why}); retried next tick`)
}

/** Logs the deny-list state when it changes, so a missing list is one event rather than one per tick. */
function recordDenylist(ledger: Ledger, state: DenylistLoad['kind'], deps: LeakDeps): Ledger {
  if (ledger.leakDenylist === state) return ledger
  deps.log('burndown_leak_denylist', { state, checked: state === 'ok' ? 'all categories' : 'home-path only' })
  return { ...ledger, leakDenylist: state }
}

async function checkPull(pass: Pass, pull: Pull, found: Found): Promise<void> {
  const claim = owningClaim(pass.ledger, pull)
  if (claim === undefined && !pull.branch.startsWith(BRANCH_PREFIX)) return
  const text = [...scanText(pull.title, pass.ctx, 'title'), ...scanText(pull.body, pass.ctx, 'body')]
  const none = { findings: [], lines: [] }
  const branch = claim === undefined ? none : await scanBranch(claim, pull, pass.ctx, pass.deps)
  pass.lines.push(...branch.lines)
  const rows = [...new Set([...text, ...branch.findings].map(where))]
  const url = redactText(pull.url, buildMatchers(pass.ctx))
  if (claim?.seat !== undefined && pass.deps.seats.includes(claim.seat)) {
    found.set(claim, [...(found.get(claim) ?? []), { number: pull.number, url, rows }])
    return
  }
  if (rows.length > 0) fileHuman(pass, humanItem(pull, url, rows, claim))
}

function fileHuman(pass: Pass, item: HumanItem): void {
  pass.current.add(item.key)
  if (!(pass.ledger.humanFiled ?? []).includes(item.key)) pass.human.push(item)
}

/** The held claim whose PR this is, by URL, else by one of its agents' branches. */
function owningClaim(ledger: Ledger, pull: Pull): Claim | undefined {
  const held = heldClaims(ledger)
  return (
    held.find(c => c.pr === pull.url) ??
    held.find(c => (c.spawned ?? []).some(name => `${BRANCH_PREFIX}${name}` === pull.branch))
  )
}

const where = (f: Finding): string =>
  `${f.commit === undefined ? '' : `${f.commit} `}${f.file === 'title' ? 'title' : `${f.file}:${f.line}`} ${f.category}`

function capped(rows: readonly string[]): string[] {
  if (rows.length <= SHOWN_FINDINGS) return [...rows]
  return [...rows.slice(0, SHOWN_FINDINGS), `and ${rows.length - SHOWN_FINDINGS} more`]
}

type Leak = NonNullable<Claim['leak']>

/** The union over a claim's PRs; rows carry their PR number only when more than one PR has findings. */
function mergedLeak(repo: string, prs: readonly PrRows[]): Leak | undefined {
  const flagged = [...prs].filter(p => p.rows.length > 0).sort((a, b) => a.number - b.number)
  const [only] = flagged
  if (only === undefined) return undefined
  if (flagged.length === 1) return { repo, url: only.url, findings: capped(only.rows) }
  const rows = flagged.flatMap(p => p.rows.map(r => `#${p.number} ${r}`))
  return { repo, url: flagged.map(p => p.url).join(', '), findings: capped(rows) }
}

/** Each seated claim's union this tick, and no finding for one whose PRs in `repo` have all closed. */
function settleClaims(ledger: Ledger, repo: string, found: Found): Ledger {
  const claims = ledger.claims.map(c => {
    const prs = found.get(c)
    if (prs !== undefined) return withLeak(c, mergedLeak(repo, prs))
    return c.leak?.repo === repo ? withLeak(c, undefined) : c
  })
  return { ...ledger, claims }
}

/** A changed record drops the delivered `leak`, so the seat hears of it once per real change. */
function withLeak(claim: Claim, leak: Leak | undefined): Claim {
  const { leak: before, notified, ...rest } = claim
  if (leak === undefined) return notified === undefined ? rest : { ...rest, notified }
  const same = before !== undefined && JSON.stringify(before) === JSON.stringify(leak)
  const kept = same ? notified : notified?.filter(k => k !== 'leak')
  return { ...rest, ...(kept === undefined ? {} : { notified: kept }), leak }
}

function humanItem(pull: Pull, url: string, rows: string[], claim: Claim | undefined): HumanItem {
  const digest = createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)
  const owner = claim === undefined ? 'no burndown claim' : `claim ${claim.taskId} has no enabled seat`
  const scope = pull.private ? 'private repo, warn only' : 'public or unknown visibility'
  const shown = capped(rows)
  const text = `Leak check: ${url} (${owner}; ${scope}) has ${rows.length} finding(s): ${shown.join('; ')}. The tick did not edit or close it; the scan never shows matched text.`
  return { key: `${pull.url}#${digest}`, text, ...(claim === undefined ? {} : { task: claim.taskId }) }
}

/** Drops filed keys that no longer hold, keeping those of repos this tick could not read. */
function pruneFiled(ledger: Ledger, current: ReadonlySet<string>, read: ReadonlySet<string>): Ledger {
  if (ledger.humanFiled === undefined) return ledger
  const kept = ledger.humanFiled.filter(k => current.has(k) || !read.has(repoOfPr(k) ?? ''))
  const { humanFiled: _old, ...rest } = ledger
  return kept.length === 0 ? rest : { ...rest, humanFiled: kept }
}

/** The claim's local checkout: its worktree, else the repo that held it once the tree is parked. */
function checkoutOf(claim: Claim): string | undefined {
  if (claim.worktree === undefined) return undefined
  const repo = path.dirname(path.dirname(claim.worktree))
  return [claim.worktree, repo].find(dir => fs.existsSync(dir))
}

/** Every commit the PR's branch adds over its base, through S1's per-commit range scan. */
async function scanBranch(
  claim: Claim,
  pull: Pull,
  ctx: ScanContext,
  deps: LeakDeps,
): Promise<{ findings: Finding[]; lines: string[] }> {
  const cwd = checkoutOf(claim)
  const skipped = (why: string) => ({
    findings: [],
    lines: [`leak check skipped the branch of ${claim.taskId}: ${why}`],
  })
  if (cwd === undefined) return skipped('no local checkout')
  const refs = scanRefs(pull.number)
  try {
    if (deps.exec(GIT_BIN, privateFetch(pull, refs), cwd).status !== 0) return skipped('git fetch failed')
    const range = `${refs.base}..${refs.head}`
    return { findings: await scanRange(range, ctx, (deps.source ?? gitRangeSource)(cwd)), lines: [] }
  } catch {
    return skipped('git could not read the range')
  } finally {
    for (const ref of [refs.base, refs.head]) deps.exec(GIT_BIN, ['update-ref', '-d', ref], cwd)
  }
}

/** Refs only the leak scan writes, so the fetch moves no `origin/*` ref under the checkout's other users. */
export const scanRefs = (pr: number): { base: string; head: string } => ({
  base: `refs/agent-chat/leak-scan/${pr}/base`,
  head: `refs/agent-chat/leak-scan/${pr}/head`,
})

/** `--refmap=` turns off the opportunistic `origin/*` update, and no FETCH_HEAD is written. */
const privateFetch = (pull: Pull, refs: { base: string; head: string }): string[] => [
  'fetch',
  '--quiet',
  '--no-tags',
  '--no-write-fetch-head',
  '--refmap=',
  'origin',
  `+refs/heads/${pull.base}:${refs.base}`,
  `+refs/heads/${pull.branch}:${refs.head}`,
]
