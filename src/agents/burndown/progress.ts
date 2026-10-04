import { createHash } from 'node:crypto'
import { run, type Runner } from './exec.js'
import { GIT_BIN } from './review-diff.js'

/**
 * A worktree's own evidence of progress (CC-659): its HEAD and a hash of what
 * is uncommitted. A transcript shows an agent talking; this shows it changing
 * the code. Reads only: nothing acts on it yet.
 */

export interface Progress {
  head: string
  /** sha1 of the sorted `git status --porcelain` lines, runtime paths left out. */
  dirty: string
  dirtyCount: number
}

/**
 * Paths the harness, the toolchain and agent-chat write at a worktree's root; an
 * edit there is not the agent's work. Root only: porcelain collapses an untracked
 * directory to one line, so a nested match could not be told apart from real files.
 */
const RUNTIME_DIRS = ['.claude/', 'node_modules/', 'dist/', '.agent-chat/']

/** A porcelain v1 line is `XY path`; git quotes a path with unusual characters. */
const pathOf = (line: string): string => line.slice(3).replace(/^"|"$/g, '')

const isRuntime = (file: string): boolean => RUNTIME_DIRS.some(dir => file.startsWith(dir))

/** Any failed git call is `'unreadable'`, never a clean tree: a missing worktree has made no progress we can see. */
export function readProgress(worktree: string, exec: Runner = run): Progress | 'unreadable' {
  const head = exec(GIT_BIN, ['rev-parse', 'HEAD'], worktree)
  if (head.status !== 0 || head.stdout.trim() === '') return 'unreadable'
  const status = exec(GIT_BIN, ['status', '--porcelain=v1'], worktree)
  if (status.status !== 0) return 'unreadable'
  const lines = status.stdout
    .split('\n')
    .filter(line => line !== '' && !isRuntime(pathOf(line)))
    .sort()
  return {
    head: head.stdout.trim(),
    dirty: createHash('sha1').update(lines.join('\n')).digest('hex'),
    dirtyCount: lines.length,
  }
}
