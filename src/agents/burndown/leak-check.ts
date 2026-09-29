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
  base: string
  private: boolean
}

/** The rows kept per PR; the rest are counted, so one seat message stays readable. */
const SHOWN_FINDINGS = 8

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/

export const repoOfPr = (url: string): string | undefined => {
  const m = PR_URL.exec(url)
  return m === null ? undefined : `${m[1]}/${m[2]}`
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
export function readPulls(repo: string, exec: Runner): Pull[] | undefined {
  const jq =
    '.[] | {number, url: .html_url, title, body: (.body // ""), branch: .head.ref, base: .base.ref, private: (.base.repo.private // false)}'
  const args = ['api', '--paginate', `repos/${repo}/pulls?state=open&per_page=100`, '--jq', jq]
  const result = exec('gh', args)
  if (result.status !== 0) return undefined
  try {
    return result.stdout
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Pull)
  } catch {
    return undefined
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

const reposOf = (ledger: Ledger): string[] => [
  ...new Set(heldClaims(ledger).flatMap(c => repoOfPr(c.pr ?? '') ?? [])),
]

async function checkRepo(pass: Pass, repo: string): Promise<void> {
  const pulls = readPulls(repo, pass.deps.exec)
  if (pulls === undefined) {
    pass.deps.log('burndown_leak_reader_failed', { repo })
    pass.lines.push(
      `leak check could not list open PRs of ${redactText(repo, buildMatchers(pass.ctx))}; retried next tick`,
    )
    return
  }
  pass.read.add(repo)
  for (const pull of pulls) {
    const outcome = await checkPull(pass.ledger, pull, pass.ctx, pass.deps)
    pass.ledger = outcome.ledger
    pass.lines.push(...outcome.lines)
    if (outcome.human === undefined) continue
    pass.current.add(outcome.human.key)
    if (!(pass.ledger.humanFiled ?? []).includes(outcome.human.key)) pass.human.push(outcome.human)
  }
  pass.ledger = clearFixed(pass.ledger, repo, pulls)
}

/** Logs the deny-list state when it changes, so a missing list is one event rather than one per tick. */
function recordDenylist(ledger: Ledger, state: DenylistLoad['kind'], deps: LeakDeps): Ledger {
  if (ledger.leakDenylist === state) return ledger
  deps.log('burndown_leak_denylist', { state, checked: state === 'ok' ? 'all categories' : 'home-path only' })
  return { ...ledger, leakDenylist: state }
}

interface PullOutcome {
  ledger: Ledger
  lines: string[]
  human?: HumanItem
}

async function checkPull(ledger: Ledger, pull: Pull, ctx: ScanContext, deps: LeakDeps): Promise<PullOutcome> {
  const claim = owningClaim(ledger, pull)
  if (claim === undefined && !pull.branch.startsWith(BRANCH_PREFIX)) return { ledger, lines: [] }
  const text = [...scanText(pull.title, ctx, 'title'), ...scanText(pull.body, ctx, 'body')]
  const branch = claim === undefined ? { findings: [], lines: [] } : await scanBranch(claim, pull, ctx, deps)
  const rows = shownRows([...text, ...branch.findings])
  const url = redactText(pull.url, buildMatchers(ctx))
  const seated = claim?.seat !== undefined && deps.seats.includes(claim.seat)
  if (claim !== undefined && seated) return { ledger: setLeak(ledger, claim, url, rows), lines: branch.lines }
  if (rows.length === 0) return { ledger, lines: branch.lines }
  return { ledger, lines: branch.lines, human: humanItem(pull, url, rows, claim) }
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

function shownRows(findings: readonly Finding[]): string[] {
  const rows = [...new Set(findings.map(where))]
  if (rows.length <= SHOWN_FINDINGS) return rows
  return [...rows.slice(0, SHOWN_FINDINGS), `and ${rows.length - SHOWN_FINDINGS} more`]
}

/** Sets the claim's findings; a changed set drops the delivered `leak`, so the seat hears of the new ones. */
function setLeak(ledger: Ledger, claim: Claim, url: string, rows: string[]): Ledger {
  const claims = ledger.claims.map(c => {
    if (c !== claim) return c
    const { leak: before, ...rest } = c
    if (rows.length === 0) return rest
    const same = before !== undefined && before.url === url && before.findings.join('\n') === rows.join('\n')
    const notified = same ? c.notified : c.notified?.filter(k => k !== 'leak')
    const { notified: _old, ...base } = rest
    return { ...base, ...(notified === undefined ? {} : { notified }), leak: { url, findings: rows } }
  })
  return { ...ledger, claims }
}

function humanItem(pull: Pull, url: string, rows: string[], claim: Claim | undefined): HumanItem {
  const digest = createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)
  const owner = claim === undefined ? 'no burndown claim' : `claim ${claim.taskId} has no enabled seat`
  const scope = pull.private ? 'private repo, warn only' : 'public or unknown visibility'
  const text = `Leak check: ${url} (${owner}; ${scope}) has ${rows.length} finding(s): ${rows.join('; ')}. The tick did not edit or close it; the scan never shows matched text.`
  return { key: `${pull.url}#${digest}`, text, ...(claim === undefined ? {} : { task: claim.taskId }) }
}

/** A claim whose PR is no longer open in a repo just read has nothing left to flag. */
function clearFixed(ledger: Ledger, repo: string, pulls: readonly Pull[]): Ledger {
  const open = new Set(pulls.map(p => p.url))
  const claims = ledger.claims.map(c => {
    if (c.leak === undefined || c.pr === undefined || repoOfPr(c.pr) !== repo || open.has(c.pr)) return c
    const { leak: _gone, ...rest } = c
    return rest
  })
  return { ...ledger, claims }
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

/** Every commit the PR's branch adds over its base, after a fetch, through S1's per-commit range scan. */
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
  const fetch = ['fetch', '--quiet', '--no-tags', 'origin', pull.base, pull.branch]
  if (deps.exec(GIT_BIN, fetch, cwd).status !== 0) return skipped('git fetch failed')
  try {
    const range = `origin/${pull.base}..origin/${pull.branch}`
    return { findings: await scanRange(range, ctx, (deps.source ?? gitRangeSource)(cwd)), lines: [] }
  } catch {
    return skipped('git could not read the range')
  }
}
