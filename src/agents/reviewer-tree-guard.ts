import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { gitChildEnv } from '../git.js'

/**
 * CC-233: a reviewer profile denies Write and Edit but allows Bash, and shell syntax has too many
 * write forms (`sed -i`, redirects, `git apply`) for a deny pattern to close. So the supervisor
 * detects instead: it fingerprints the reviewed tree before launch and again at exit, and tells
 * the spawner which paths changed. Nothing is reverted; the spawner decides.
 */
export const REVIEWER_TREE_CHANGED = 'reviewer-tree-changed'

/** Each dirty path's status and content hash, plus HEAD, so a commit by the reviewer counts too. */
export interface TreeFingerprint {
  head: string
  entries: Map<string, string>
}

/** Raw stdout, or null when git fails. Untrimmed: porcelain's first column may be a space. */
export type RawGitRunner = (args: readonly string[], cwd: string) => Promise<string | null>

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 64 << 20

export const runRawGit: RawGitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      env: gitChildEnv(),
      maxBuffer: MAX_GIT_OUTPUT,
    })
    return stdout
  } catch {
    return null
  }
}

/** `git status -z` records as [status, path]; a rename's or copy's source path is its own record. */
function parseStatus(raw: string): [string, string][] {
  const records = raw.split('\0').filter(r => r !== '')
  const parsed: [string, string][] = []
  for (let record = records.shift(); record !== undefined; record = records.shift()) {
    const status = record.slice(0, 2)
    parsed.push([status, record.slice(3)])
    const source = /[RC]/.test(status) ? records.shift() : undefined
    if (source !== undefined) parsed.push([status, source])
  }
  return parsed
}

function contentHash(file: string): string {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`
    if (!stat.isFile()) return 'other'
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return 'absent'
  }
}

/** Read-only. Undefined when `cwd` is not a git work tree. */
export async function treeFingerprint(
  cwd: string,
  git: RawGitRunner = runRawGit,
): Promise<TreeFingerprint | undefined> {
  const status = await git(['status', '--porcelain=v1', '-z', '-uall'], cwd)
  if (status === null) return undefined
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], cwd))?.trim() ?? ''
  const entries = new Map<string, string>()
  for (const [code, file] of parseStatus(status)) {
    entries.set(file, `${code}:${contentHash(path.join(cwd, file))}`)
  }
  return { head, entries }
}

/** Paths whose status or content differ between the two reads; `HEAD` when the commit moved. */
export function treeChange(before: TreeFingerprint, after: TreeFingerprint): string[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()])
  const changed = [...paths].filter(p => before.entries.get(p) !== after.entries.get(p)).sort()
  return before.head === after.head ? changed : ['HEAD', ...changed]
}

const PATHS_SHOWN = 5

export function reviewerDirtyText(name: string, cwd: string, paths: readonly string[]): string {
  const shown = paths.slice(0, PATHS_SHOWN).join(', ')
  const more = paths.length > PATHS_SHOWN ? ` +${paths.length - PATHS_SHOWN} more` : ''
  return `Reviewer ${name} exited having changed the tree it reviewed (${cwd}): ${shown}${more}. Nothing was reverted.`
}
