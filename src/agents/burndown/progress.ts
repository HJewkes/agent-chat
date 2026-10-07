import { createHash } from 'node:crypto'
import { run, type Runner } from './exec.js'
import { GIT_BIN, resolveBaseRef } from './review-diff.js'

/**
 * A worktree's own evidence of progress (CC-659): its HEAD and a hash of what
 * is uncommitted. A transcript shows an agent talking; this shows it changing
 * the code. `lease.ts` renews a claim's lease from it.
 */

export interface Progress {
  head: string
  /** sha1 of the sorted `git status --porcelain` lines, runtime paths left out. */
  dirty: string
  dirtyCount: number
  /**
   * sha1 of `dirty` and `git diff HEAD`, runtime paths left out: a second edit to a
   * file already dirty changes it, and so does a new untracked file, which the diff
   * leaves out. `dirty` alone when the diff cannot be read, such as one over the
   * runner's output buffer.
   */
  content: string
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

const DIFF_ARGS = [
  'diff',
  'HEAD',
  '--no-color',
  '--no-ext-diff',
  '--',
  '.',
  ...RUNTIME_DIRS.map(dir => `:(top,exclude)${dir}`),
]

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

/** A failed head or status read is `'unreadable'`, never a clean tree: a missing worktree has made no progress we can see. */
export function readProgress(worktree: string, exec: Runner = run): Progress | 'unreadable' {
  const head = exec(GIT_BIN, ['rev-parse', 'HEAD'], worktree)
  if (head.status !== 0 || head.stdout.trim() === '') return 'unreadable'
  const status = exec(GIT_BIN, ['status', '--porcelain=v1'], worktree)
  if (status.status !== 0) return 'unreadable'
  const lines = status.stdout
    .split('\n')
    .filter(line => line !== '' && !isRuntime(pathOf(line)))
    .sort()
  const dirty = sha1(lines.join('\n'))
  const diff = exec(GIT_BIN, DIFF_ARGS, worktree)
  return {
    head: head.stdout.trim(),
    dirty,
    dirtyCount: lines.length,
    content: diff.status === 0 ? sha1(`${dirty}\n${diff.stdout}`) : dirty,
  }
}

/**
 * What a stalled agent left in its worktree, for its successor's brief (CC-660):
 * `git diff --stat` of the branch against its base, then `git status --short`.
 * Raw git output; the brief caps and fences it.
 */
export function diffSummary(worktree: string, exec: Runner = run): string {
  const base = resolveBaseRef(worktree, exec)
  const stat =
    base === undefined
      ? undefined
      : exec(GIT_BIN, ['diff', '--stat', '--no-color', `${base}...HEAD`], worktree)
  const status = exec(GIT_BIN, ['status', '--short'], worktree)
  return [
    `committed since ${base ?? 'the base'}:`,
    stat?.status === 0 ? stat.stdout.trimEnd() || '(none)' : '(unreadable)',
    'uncommitted:',
    status.status === 0 ? status.stdout.trimEnd() || '(none)' : '(unreadable)',
  ].join('\n')
}
