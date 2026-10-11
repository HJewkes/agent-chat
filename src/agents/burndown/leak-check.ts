import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { egressRunner, type EgressFinding, type EgressOutcome, type EgressRunner } from './egress-runner.js'
import type { Runner } from './exec.js'
import { heldClaims, type Claim, type Ledger } from './ledger.js'
import type { HumanItem } from './seat-deliver.js'
import { GIT_BIN } from './review-diff.js'

/**
 * The tick's leak backstop (CC-265): scan the open PRs of every repo the ledger has a PR in, with
 * the scanner and private term list the pre-push hook uses. A claim's finding becomes its seat's
 * `leak` event; any other agent PR's goes to the human queue. It reads PRs over REST only and never
 * edits or closes one. Findings carry location and rule, never text. With no scanner or no term
 * list it scans nothing and says so, so no PR is ever reported clean unscanned.
 */

export interface LeakDeps {
  exec: Runner
  log: (event: string, detail: Record<string, unknown>) => void
  /** Seats the tick tells; a claim of any other seat, or of none, goes to the human queue. */
  seats: readonly string[]
  /** The scanner; a test injects one. */
  egress?: EgressRunner
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
  /** The base repo's default branch; only its `.egress-allow` counts in the branch scan. */
  defaultBranch: string
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
  '.[] | {number, url: .html_url, title, body: (.body // ""), branch: .head.ref, headRepo: (.head.repo.full_name // ""), base: .base.ref, defaultBranch: (.base.repo.default_branch // ""), private: (.base.repo.private // false)}'

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
  sweepScanRefs(ledger, deps.exec)
  const egress = deps.egress ?? egressRunner()
  const health = egress.text('')
  const pass: Pass = {
    egress,
    deps,
    ledger: recordScanner(ledger, health, deps),
    human: [],
    lines: [],
    current: new Set(),
    read: new Set(),
    scans: { ...ledger.leakScans },
  }
  if (health.state === 'ok') for (const repo of repos) await checkRepo(pass, repo)
  else scannerDown(pass, health)
  const ledgerOut = withScans(pruneFiled(pass.ledger, pass.current, pass.read), pass.scans)
  return { ledger: ledgerOut, human: pass.human, lines: pass.lines }
}

/** One tick's running state across repos. */
interface Pass {
  egress: EgressRunner
  deps: LeakDeps
  ledger: Ledger
  human: HumanItem[]
  lines: string[]
  /** Keys of every human item whose finding holds this tick, filed or not. */
  current: Set<string>
  /** Repos whose open PRs were read this tick. */
  read: Set<string>
  /** Each PR's last rows per part; a part scanned this tick replaces its own, an unscanned one stands. */
  scans: Scans
}

type Scans = NonNullable<Ledger['leakScans']>
type PartRows = Scans[string]

/** Human-queue keys for a scanner outage; never a PR URL, so only a healthy tick clears one. */
const SCANNER_KEY = 'leak-scanner:'

const SCANNER_WHY: Record<Exclude<EgressOutcome['state'], 'ok'>, string> = {
  'no-scanner': "no titan-egress-scan (or node) on the tick's PATH",
  'no-terms': 'the private term list is missing, unreadable or empty',
  error: 'titan-egress-scan failed',
}

function scannerDown(pass: Pass, outcome: Exclude<EgressOutcome, { state: 'ok' }>): void {
  const why = SCANNER_WHY[outcome.state]
  pass.lines.push(`leak check scanned no PR: ${why}; no PR is reported clean`)
  fileHuman(pass, {
    key: `${SCANNER_KEY}${outcome.state}`,
    text: `Leak check is down: ${why}, so the tick scanned no PR title, body or branch. Install @titan-design/egress-scan where the tick can find it and keep the term list in place; see docs/leak-guard.md.`,
  })
}

/** One PR's findings for a seated claim; a claim collects every PR it owns before its record is compared. */
interface PrRows {
  number: number
  url: string
  rows: string[]
}

type Found = Map<Claim, PrRows[]>

/** The repo a PR is listed under, and whether its name may be shown in a message. */
interface RepoView {
  repo: string
  shown: boolean
}

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
  const shownRepo = repoShown(pass, repo)
  const listed = pulls.filter(p => fromBaseRepo(p, repo))
  for (const pull of listed) await checkPull(pass, pull, found, { repo, shown: shownRepo === repo })
  dropClosed(pass, repo, new Set(listed.map(p => p.url)))
  pass.ledger = settleClaims(pass.ledger, repo, found)
}

/** Forgets the stored rows of the repo's PRs that are no longer open. */
function dropClosed(pass: Pass, repo: string, open: ReadonlySet<string>): void {
  for (const url of Object.keys(pass.scans)) {
    if (repoOfPr(url) === repo && !open.has(url)) delete pass.scans[url]
  }
}

/** The repo name as a message may show it: redacted when it holds a finding or could not be scanned. */
function repoShown(pass: Pass, repo: string): string {
  const scanned = pass.egress.text(repo)
  return scanned.state === 'ok' && scanned.findings.length === 0 ? repo : '[redacted repo]'
}

function readFailed(pass: Pass, repo: string, failure: ReadFailure): void {
  pass.deps.log('burndown_leak_reader_failed', { repo, ...failure })
  const why = [
    failure.http === undefined ? `exit ${failure.exit ?? 'none'}` : `HTTP ${failure.http}`,
    ...(failure.rateLimited ? ['rate limited'] : []),
  ].join(', ')
  pass.lines.push(
    `leak check could not list open PRs of ${repoShown(pass, repo)} (${why}); retried next tick`,
  )
}

/** Logs the scanner state when it changes, so a missing scanner is one event rather than one per tick. */
function recordScanner(ledger: Ledger, outcome: EgressOutcome, deps: LeakDeps): Ledger {
  if (ledger.leakScanner === outcome.state) return ledger
  const detail = outcome.state === 'ok' || outcome.detail === undefined ? {} : { detail: outcome.detail }
  deps.log('burndown_leak_scanner', { state: outcome.state, ...detail })
  return { ...ledger, leakScanner: outcome.state }
}

/** Title and body in one scan: the title is line 1, so body line n is scanner line n + 1. */
function scanPullText(pass: Pass, pull: Pull): string[] | undefined {
  const title = pull.title.replace(/[\r\n]+/g, ' ')
  const scanned = pass.egress.text(`${title}\n${pull.body}`)
  if (scanned.state !== 'ok') return undefined
  return scanned.findings.map(({ location, rule }) => {
    const [line = '', col = ''] = location.split(':')
    return Number(line) === 1 ? `title 1:${col} ${rule}` : `body ${Number(line) - 1}:${col} ${rule}`
  })
}

async function checkPull(pass: Pass, pull: Pull, found: Found, where: RepoView): Promise<void> {
  const claim = owningClaim(pass.ledger, pull, where.repo)
  if (claim === undefined && !pull.branch.startsWith(BRANCH_PREFIX)) return
  const url = where.shown ? pull.url : '[redacted url]'
  const rows = scanPull(pass, pull, claim, url)
  if (claim?.seat !== undefined && pass.deps.seats.includes(claim.seat)) {
    found.set(claim, [...(found.get(claim) ?? []), { number: pull.number, url, rows }])
    return
  }
  if (rows.length > 0) fileHuman(pass, humanItem(pull, url, rows, claim))
}

/**
 * One PR's rows: each part scanned this tick replaces its stored rows, and a part that could not be
 * scanned keeps them. Only a claim's PR has a branch part; any other PR's is dropped.
 */
function scanPull(pass: Pass, pull: Pull, claim: Claim | undefined, url: string): string[] {
  const last = pass.scans[pull.url] ?? {}
  const text = scanPullText(pass, pull) ?? lastRows(pass, `could not scan the text of ${url}`, last.text)
  const branch = claim === undefined ? [] : branchRows(pass, claim, pull, last.branch)
  storeScan(pass, pull.url, { text, branch })
  return [...new Set([...text, ...branch])]
}

function branchRows(pass: Pass, claim: Claim, pull: Pull, last: string[] | undefined): string[] {
  const branch = scanBranch(claim, pull, pass)
  if ('rows' in branch) return branch.rows
  return lastRows(pass, `skipped the branch of ${claim.taskId}: ${branch.skipped}`, last)
}

function lastRows(pass: Pass, why: string, last: string[] | undefined): string[] {
  pass.lines.push(`leak check ${why}; its last result stands`)
  return last ?? []
}

function storeScan(pass: Pass, url: string, parts: { text: string[]; branch: string[] }): void {
  const kept: PartRows = {
    ...(parts.text.length === 0 ? {} : { text: parts.text }),
    ...(parts.branch.length === 0 ? {} : { branch: parts.branch }),
  }
  if (Object.keys(kept).length === 0) delete pass.scans[url]
  else pass.scans[url] = kept
}

function withScans(ledger: Ledger, scans: Scans): Ledger {
  const { leakScans: _old, ...rest } = ledger
  return Object.keys(scans).length === 0 ? rest : { ...rest, leakScans: scans }
}

function fileHuman(pass: Pass, item: HumanItem): void {
  pass.current.add(item.key)
  if (!(pass.ledger.humanFiled ?? []).includes(item.key)) pass.human.push(item)
}

/** The held claim whose PR this is, by URL, else by one of its agents' branches in the repo of its PR. */
function owningClaim(ledger: Ledger, pull: Pull, repo: string): Claim | undefined {
  const held = heldClaims(ledger)
  const inRepo = (c: Claim): boolean =>
    c.pr === undefined || (repoOfPr(c.pr) ?? '').toLowerCase() === repo.toLowerCase()
  return (
    held.find(c => c.pr === pull.url) ??
    held.find(c => inRepo(c) && (c.spawned ?? []).some(name => `${BRANCH_PREFIX}${name}` === pull.branch))
  )
}

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

/** Drops filed keys that no longer hold, keeping those of repos not read. */
function pruneFiled(ledger: Ledger, current: ReadonlySet<string>, read: ReadonlySet<string>): Ledger {
  if (ledger.humanFiled === undefined) return ledger
  const holds = (k: string): boolean =>
    current.has(k) || (!k.startsWith(SCANNER_KEY) && !read.has(repoOfPr(k) ?? ''))
  const kept = ledger.humanFiled.filter(holds)
  const { humanFiled: _old, ...rest } = ledger
  return kept.length === 0 ? rest : { ...rest, humanFiled: kept }
}

/** The claim's local checkout: its worktree, else the repo that held it once the tree is parked. */
function checkoutOf(claim: Claim): string | undefined {
  if (claim.worktree === undefined) return undefined
  const repo = path.dirname(path.dirname(claim.worktree))
  return [claim.worktree, repo].find(dir => fs.existsSync(dir))
}

/** A branch scan's rows, or why there are none; only a scanner result is ever a scan. */
type BranchScan = { rows: string[] } | { skipped: string }

/** Every commit the PR's branch adds over its base, through the scanner's per-commit range scan. */
function scanBranch(claim: Claim, pull: Pull, pass: Pass): BranchScan {
  const cwd = checkoutOf(claim)
  if (cwd === undefined) return { skipped: 'no local checkout' }
  const refs = scanRefs(pull.number)
  try {
    if (pass.deps.exec(GIT_BIN, privateFetch(pull, refs), cwd).status !== 0)
      return { skipped: 'git fetch failed' }
    const allowFrom = pull.base === pull.defaultBranch ? refs.base : undefined
    const scanned = pass.egress.range(cwd, refs.base, refs.head, allowFrom)
    if (scanned.state !== 'ok') return { skipped: `the scanner reported ${scanned.state}` }
    return { rows: scanned.findings.map(branchRow) }
  } catch {
    return { skipped: 'the branch scan failed' }
  } finally {
    for (const ref of [refs.base, refs.head]) pass.deps.exec(GIT_BIN, ['update-ref', '-d', ref], cwd)
  }
}

/** `commit <sha> <file>:<line>` from the scanner, shown as `<sha> <file>:<line> <rule>`. */
const branchRow = ({ location, rule }: EgressFinding): string => `${location.replace(/^commit /, '')} ${rule}`

const SCAN_REF_ROOT = 'refs/agent-chat/leak-scan/'

/** Deletes scan refs a crashed run or a closed PR left behind, so none outlives the tick after it. */
function sweepScanRefs(ledger: Ledger, exec: Runner): void {
  const checkouts = new Set(heldClaims(ledger).flatMap(c => checkoutOf(c) ?? []))
  for (const cwd of checkouts) {
    const listed = exec(GIT_BIN, ['for-each-ref', '--format=%(refname)', SCAN_REF_ROOT], cwd)
    if (listed.status !== 0) continue
    for (const ref of listed.stdout.split('\n').filter(r => r.startsWith(SCAN_REF_ROOT))) {
      exec(GIT_BIN, ['update-ref', '-d', ref], cwd)
    }
  }
}

/** Refs only the leak scan writes, so the fetch moves no `origin/*` ref under the checkout's other users. */
export const scanRefs = (pr: number): { base: string; head: string } => ({
  base: `${SCAN_REF_ROOT}${pr}/base`,
  head: `${SCAN_REF_ROOT}${pr}/head`,
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
