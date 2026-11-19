import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { runGit, type GitRunner } from '../../git.js'

/**
 * A `.git` in the home directory makes every untracked-walking git call read the whole of HOME,
 * which has frozen the machine. A resource refusal only: callers answer "unknown" and judge nothing.
 */
const canonical = (dir: string): string => {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

export const sameAsHome = (toplevel: string): boolean => canonical(toplevel) === canonical(homedir())

/** True when `git rev-parse --show-toplevel` in `dir` is the home directory. */
export async function isHomeRepo(dir: string, git: GitRunner = runGit): Promise<boolean> {
  const top = await git(['rev-parse', '--show-toplevel'], dir)
  return top !== null && sameAsHome(top.trim())
}

export const homeRefusal = (dir: string): string =>
  `${dir} sits in a git repository rooted at the home directory; not walking its untracked files`
