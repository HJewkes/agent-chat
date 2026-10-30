import fs from 'node:fs'
import path from 'node:path'

export type GitMarker = 'dir' | 'file'

/**
 * What `<dir>/.git` is, counting it only when git would: a file starting with `gitdir:` or a
 * directory holding HEAD. An empty `.git` directory is not a repository, so callers keep walking up.
 */
export function gitMarkerAt(dir: string): GitMarker | undefined {
  const dotGit = path.join(dir, '.git')
  try {
    const stat = fs.statSync(dotGit)
    if (stat.isDirectory()) return fs.existsSync(path.join(dotGit, 'HEAD')) ? 'dir' : undefined
    return fs.readFileSync(dotGit, 'utf8').startsWith('gitdir:') ? 'file' : undefined
  } catch {
    return undefined
  }
}
