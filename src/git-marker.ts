import fs from 'node:fs'
import path from 'node:path'

/**
 * `dir` and `file` are a repository or a linked worktree. `broken` is a `.git` that is present but
 * cannot be vouched for (an unreadable directory, a file that is not a `gitdir:` pointer): git may
 * well refuse it, so a caller that must not call a doubtful repo clean counts it and one that must
 * not trust a doubtful repo walks past it.
 */
export type GitMarker = 'dir' | 'file' | 'broken'

/**
 * What `<dir>/.git` is. A readable directory without HEAD (an empty one) is not a repository and
 * yields undefined, so callers keep walking up.
 */
export function gitMarkerAt(dir: string): GitMarker | undefined {
  const dotGit = path.join(dir, '.git')
  try {
    if (!fs.statSync(dotGit).isDirectory()) {
      return fs.readFileSync(dotGit, 'utf8').startsWith('gitdir:') ? 'file' : 'broken'
    }
    return fs.readdirSync(dotGit).includes('HEAD') ? 'dir' : undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'broken'
  }
}
