import fs from 'node:fs'
import { run, type Runner } from './exec.js'

/**
 * Whether a finished worker's worktree holds anything for a reviewer to read.
 * A port of relay `daemon/src/review.ts` `assessDiff`, with its asymmetric
 * failure rule: a missing worktree has provably nothing to review, but any git
 * failure inside an existing one reviews rather than risking unreviewed writes.
 * Relay keeps its own copy until a shared "worktree diff verdict" package exists.
 */

export interface DiffVerdict {
  reviewable: boolean
  reason: string
}

export const GIT_BIN = '/usr/bin/git'

const BASE_REF_CANDIDATES = ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master']

function resolveBaseRef(cwd: string, exec: Runner): string | undefined {
  return BASE_REF_CANDIDATES.find(
    ref => exec(GIT_BIN, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).status === 0,
  )
}

export function assessDiff(cwd: string, exec: Runner = run): DiffVerdict {
  if (!fs.existsSync(cwd))
    return { reviewable: false, reason: `worktree ${cwd} no longer exists; nothing to review` }

  const dirty = exec(GIT_BIN, ['status', '--porcelain'], cwd)
  if (dirty.status === 0 && dirty.stdout.trim() !== '')
    return { reviewable: true, reason: 'worktree has uncommitted changes' }

  const base = resolveBaseRef(cwd, exec)
  if (base === undefined)
    return { reviewable: true, reason: 'no base ref resolved; reviewing rather than assuming no diff' }

  const ahead = exec(GIT_BIN, ['rev-list', '--count', `${base}..HEAD`], cwd)
  const commits = Number(ahead.stdout.trim())
  if (ahead.status !== 0 || !Number.isInteger(commits))
    return {
      reviewable: true,
      reason: `git rev-list against ${base} failed; reviewing rather than assuming no diff`,
    }
  return commits > 0
    ? { reviewable: true, reason: `${commits} commit(s) ahead of ${base}` }
    : { reviewable: false, reason: `clean worktree and no commits ahead of ${base}` }
}
