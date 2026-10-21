import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { runGit as gitOrNull } from '@titan-design/worktree'

/**
 * What removing a tree would lose, under agent-chat's policy for ignored files. Park, release and
 * the sweep all judge a tree by this, so a build output one of them regenerates is not unsaved
 * work to another. Every failed read refuses.
 */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType
}

/** Ignored paths `git worktree remove` would delete that a build or agent-chat's own re-attach puts back. */
const REGENERABLE_DIRS = ['node_modules', 'dist', 'coverage', '.turbo', '.api-extractor-temp']

/** Tool caches that sit at any depth as single files. */
const REGENERABLE_FILES = ['.eslintcache']

/** Single files at any depth by suffix; `tsc --incremental` writes these on every build. */
const REGENERABLE_FILE_SUFFIXES = ['.tsbuildinfo']

/** `.claude` only at the top, since re-attach copies it from the repository root. Suffixes apply to files only: a directory so named may hold anything. */
const isRegenerable = (entry: string): boolean => {
  const segments = entry.split('/').filter(Boolean)
  const name = entry.endsWith('/') ? undefined : segments.at(-1)
  if (name !== undefined && REGENERABLE_FILE_SUFFIXES.some(suffix => name.endsWith(suffix))) return true
  if (name !== undefined && REGENERABLE_FILES.includes(name)) return true
  return segments[0] === '.claude' || segments.some(segment => REGENERABLE_DIRS.includes(segment))
}

/** Codewatch writes its graph index at the git toplevel only, so a nested copy is not matched. */
const CODEWATCH_INDEX = '.codewatch/graph.db'
const CODEWATCH_INDEX_FILES = ['', '-wal', '-shm', '-journal'].map(suffix => CODEWATCH_INDEX + suffix)

/** Tables re-indexing rebuilds: the code-graph index and store-sqlite's migration ledger. */
const REBUILT_GRAPH_TABLES = [
  '_migration',
  'snapshot',
  'node',
  'edge',
  'metric',
  'id_alias',
  'file_fingerprint',
  'finding',
]

const tableNames = (db: DatabaseSyncType): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      .all() as { name: string }[]
  ).map(row => row.name)

const hasRows = (db: DatabaseSyncType, table: string): boolean =>
  db.prepare(`SELECT 1 FROM "${table.replaceAll('"', '""')}" LIMIT 1`).get() !== undefined

/**
 * CC-1163: re-indexing rebuilds the code-graph tables, but not paid output such as triage `verdict` rows or
 * LLM summaries in `blob_cache`. So only a code-graph db (it has a `snapshot` table) whose every other table is
 * empty counts; an unknown table with rows is kept. Any failure to read refuses.
 */
function indexOnlyGraphDb(worktree: string): boolean {
  let db: DatabaseSyncType | undefined
  try {
    db = new DatabaseSync(join(worktree, CODEWATCH_INDEX), { readOnly: true })
    const open = db
    const tables = tableNames(open)
    if (!tables.includes('snapshot')) return false
    return tables.every(table => REBUILT_GRAPH_TABLES.includes(table) || !hasRows(open, table))
  } catch {
    return false
  } finally {
    db?.close()
  }
}

function withoutIndexOnlyGraphDb(worktree: string, entries: string[]): string[] {
  if (!entries.some(entry => CODEWATCH_INDEX_FILES.includes(entry))) return entries
  if (!indexOnlyGraphDb(worktree)) return entries
  return entries.filter(entry => !CODEWATCH_INDEX_FILES.includes(entry))
}

/** `--directory` collapses a wholly ignored directory into one entry; list its files so a nested build output is judged alone. */
async function expandDirectory(worktree: string, entry: string): Promise<string[]> {
  if (!entry.endsWith('/')) return [entry]
  const files = await gitOrNull(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--', entry],
    worktree,
  )
  return files === null ? [entry] : files.split('\n').filter(Boolean)
}

/** `changes` is plain uncommitted or untracked work; `other` is a failed read or an ignored file kept. */
export interface UnsavedWork {
  kind: 'changes' | 'other'
  detail: string
}

async function unregenerableIgnored(worktree: string, ignored: string): Promise<string[]> {
  const entries = ignored.split('\n').filter(entry => entry !== '' && !isRegenerable(entry))
  // `--directory` also lists every ignored ancestor of a nested ignored dir, so expansions overlap.
  const kept = [
    ...new Set((await Promise.all(entries.map(entry => expandDirectory(worktree, entry)))).flat()),
  ]
  return withoutIndexOnlyGraphDb(
    worktree,
    kept.filter(entry => !isRegenerable(entry)),
  )
}

/** `-uall` so `status.showUntrackedFiles=no` cannot hide an untracked file the removal would take. */
export async function unsavedWork(worktree: string, action: string): Promise<UnsavedWork | undefined> {
  const status = await gitOrNull(['status', '--porcelain', '-uall'], worktree)
  if (status === null) return { kind: 'other', detail: `could not read git status in ${worktree}` }
  if (status !== '') return { kind: 'changes', detail: `uncommitted or untracked changes in ${worktree}` }
  const ignored = await gitOrNull(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    worktree,
  )
  if (ignored === null) return { kind: 'other', detail: `could not list ignored files in ${worktree}` }
  const unregenerable = await unregenerableIgnored(worktree, ignored)
  if (unregenerable.length === 0) return undefined
  const regenerable = [
    ...REGENERABLE_DIRS,
    ...REGENERABLE_FILES,
    ...REGENERABLE_FILE_SUFFIXES.map(s => `*${s}`),
  ]
  return {
    kind: 'other',
    detail:
      `ignored files in ${worktree} would be deleted (${unregenerable.slice(0, 3).join(', ')}); ` +
      `${action} removes only ignored ${regenerable.join(', ')}, a top-level .claude, and an index-only top-level ${CODEWATCH_INDEX}`,
  }
}
