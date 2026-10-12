import { existsSync } from 'node:fs'
import path from 'node:path'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import type { Runner } from './exec.js'
import type { Claim } from './ledger.js'
import { jsonLines, originRepo } from './pr-adopt-ports.js'
import { shepherdTarget, targetRef } from './shepherd.js'

/**
 * CC-1054: what GitHub says about a held claim's PR, so the tick lets go of a claim whose PR merged or whose
 * agent left no PR, which seats otherwise release by hand. One `gh` read per repo per tick; any read that
 * fails, or a page too full to rule a PR out, is "could not tell" and moves nothing.
 */

export interface RepoPull {
  number: number
  state: string
  mergedAt: string | null
  branch: string
  headSha: string
}

export interface RepoPulls {
  pulls: RepoPull[]
  /** False when the page was full, so a PR missing from it may still exist. */
  complete: boolean
}

export type ClaimPr =
  | { kind: 'merged'; pr: string; head: string }
  | { kind: 'open'; pr: string }
  /** CC-1150: the claim's recorded PR was closed unmerged, which is not the same as the agent leaving no PR. */
  | { kind: 'closed'; pr: string }
  | { kind: 'none' }

const PAGE = 100

const PULL_JQ = '.[] | {number, state, mergedAt: .merged_at, branch: .head.ref, headSha: .head.sha}'

/** The claim's recorded PR, else the PRs on its agents' branches (CC-1044: claims often carry no link). */
export function claimPrState(claim: Claim, repo: string, read: RepoPulls | undefined): ClaimPr | undefined {
  if (read === undefined) return undefined
  const recorded = shepherdTarget(claim.pr)
  const ours =
    recorded === undefined ? onBranches(claim, read.pulls) : read.pulls.filter(p => p.number === recorded.pr)
  const open = ours.find(p => p.state === 'open')
  if (open !== undefined) return { kind: 'open', pr: targetRef({ repo, pr: open.number }) }
  const merged = ours
    .filter(p => p.mergedAt !== null)
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0]
  if (merged !== undefined)
    return { kind: 'merged', pr: targetRef({ repo, pr: merged.number }), head: merged.headSha }
  const closed = recorded === undefined ? undefined : ours[0]
  if (closed !== undefined) return { kind: 'closed', pr: targetRef({ repo, pr: closed.number }) }
  return ours.length > 0 || read.complete ? { kind: 'none' } : undefined
}

/**
 * Agent names repeat across dispatches of a task, so a branch match counts a merge only after this claim was
 * dispatched: an earlier dispatch's merged PR on the same branch never finishes it.
 */
function onBranches(claim: Claim, pulls: readonly RepoPull[]): RepoPull[] {
  const names = [...(claim.spawned ?? []), ...(claim.agentName === undefined ? [] : [claim.agentName])]
  const branches = new Set(names.map(name => `${BRANCH_PREFIX}${name}`))
  return pulls.filter(
    p =>
      branches.has(p.branch) &&
      (p.mergedAt === null || Date.parse(p.mergedAt) >= Date.parse(claim.spawnedAt)),
  )
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
export function readRepoPulls(repo: string, exec: Runner): RepoPulls | undefined {
  const result = exec('gh', [
    'api',
    `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE}`,
    '--jq',
    PULL_JQ,
  ])
  if (result.status !== 0) return undefined
  const pulls: RepoPull[] = []
  for (const line of jsonLines(result.stdout)) {
    const p = line as Partial<RepoPull> | undefined
    if (typeof p?.number !== 'number' || typeof p.state !== 'string' || typeof p.branch !== 'string')
      return undefined
    pulls.push({
      number: p.number,
      state: p.state,
      mergedAt: p.mergedAt ?? null,
      branch: p.branch,
      headSha: p.headSha ?? '',
    })
  }
  return { pulls, complete: pulls.length < PAGE }
}

/** The tick's reader: each repo's pulls and each checkout's origin read at most once, however many claims share them. */
export function claimPrReader(exec: Runner): (claim: Claim) => ClaimPr | undefined {
  const pulls = new Map<string, RepoPulls | undefined>()
  const origins = new Map<string, string | undefined>()
  const originOf = (checkout: string): string | undefined => {
    if (!origins.has(checkout)) origins.set(checkout, originRepo(checkout, exec))
    return origins.get(checkout)
  }
  return claim => {
    const checkout = claim.worktree === undefined ? undefined : liveCheckout(claim.worktree)
    const repo = shepherdTarget(claim.pr)?.repo ?? (checkout === undefined ? undefined : originOf(checkout))
    if (repo === undefined) return undefined
    if (!pulls.has(repo)) pulls.set(repo, readRepoPulls(repo, exec))
    return claimPrState(claim, repo, pulls.get(repo))
  }
}

/**
 * CC-1074: a parked tree is gone, so its origin is read from the checkout it was cut under
 * (`<checkout>/.worktrees/<name>`, see `worktreePathFor`).
 */
function liveCheckout(worktree: string): string {
  const parent = path.dirname(worktree)
  return existsSync(worktree) || path.basename(parent) !== '.worktrees' ? worktree : path.dirname(parent)
}
