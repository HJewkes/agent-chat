import { run, type Runner } from './exec.js'
import { originRepo } from './pr-adopt-ports.js'
import { GIT_BIN, resolveBaseRef } from './review-diff.js'

/**
 * CC-673: what an implementer that exited without a readable status left behind, read
 * from git and GitHub rather than from its report. `advance` adopts it: an open PR on its
 * branch goes to Shepherd, commits ahead get one resume successor, and nothing releases
 * the claim. Pattern from issue-orchestrator's startup adoption (IOT-AGENA-19, Apache-2.0).
 */

export interface ExitedWork {
  /** The open PR whose head is the worktree's branch; null when GitHub lists none or origin is not on GitHub. */
  openPr: string | null
  /** Commits on the branch ahead of the default branch. */
  ahead: number
}

/** Undefined when any read failed, so the claim waits a tick rather than moving on a guess. */
export function readExitedWork(worktree: string, exec: Runner = run): ExitedWork | undefined {
  const ahead = commitsAhead(worktree, exec)
  if (ahead === undefined) return undefined
  const openPr = openPrOn(worktree, exec)
  return openPr === undefined ? undefined : { openPr, ahead }
}

function commitsAhead(worktree: string, exec: Runner): number | undefined {
  const base = resolveBaseRef(worktree, exec)
  if (base === undefined) return undefined
  const result = exec(GIT_BIN, ['rev-list', '--count', `${base}..HEAD`], worktree)
  const count = Number(result.stdout.trim())
  return result.status === 0 && result.stdout.trim() !== '' && Number.isInteger(count) ? count : undefined
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
function openPrOn(worktree: string, exec: Runner): string | null | undefined {
  const branch = exec(GIT_BIN, ['rev-parse', '--abbrev-ref', 'HEAD'], worktree)
  const name = branch.stdout.trim()
  if (branch.status !== 0 || name === '' || name === 'HEAD') return undefined
  const repo = originRepo(worktree, exec)
  if (repo === undefined) return null
  const owner = repo.split('/')[0] ?? ''
  const head = encodeURIComponent(`${owner}:${name}`)
  const result = exec('gh', [
    'api',
    `repos/${repo}/pulls?state=open&head=${head}&per_page=1`,
    '--jq',
    '.[0].html_url // ""',
  ])
  if (result.status !== 0) return undefined
  const url = result.stdout.trim()
  return url === '' ? null : url
}
