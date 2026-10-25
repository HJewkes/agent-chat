import { mayExpandToWord } from './git-word.js'
import { pushOptionsEnd } from './push-words.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * Whether a glob or brace word on a git run may form a push that skips the hook (TP-4235). The guard
 * reads `--no-verif?` as written, but the shell may match it to a file named `--no-verify`, and
 * `{git,push,--no-verify}` expands to all three words. It fails closed: an unquoted glob or brace
 * that may match the word denies whatever the directory holds. A quoted glob stays literal. A glob
 * command word is left to TP-721, since `*` there would match push in every `case` pattern.
 */

const HOOK_SKIPS = ['--no-veri', '--no-verif', '--no-verify']
const GLOB_OR_GROUP = new RegExp(`${LIVE}[*?[{(]`)
const GROUP = new RegExp(`${LIVE}[{(]`)

const mayExpandToAny = (marked: string, names: readonly string[], live = GLOB_OR_GROUP): boolean =>
  live.test(marked) && names.some(name => mayExpandToWord(unmark(marked), name))

/** A git run as this check reads it: its marked words, how each resolves, and the command word behind it. */
export interface GlobPushRun {
  marked: readonly string[]
  resolved: readonly (string | undefined)[]
  tied: boolean
  head?: string
}

/** Whether the run's command word, or a push option before the `--` that ends them, may expand to push or `--no-verify`. */
export function globMayFormPush(run: GlobPushRun, at: number): boolean {
  if (run.tied && run.head !== undefined && mayExpandToAny(run.head, ['push', ...HOOK_SKIPS], GROUP))
    return true
  if (at < 0 || at >= run.marked.length) return false
  const sub = run.resolved[at]
  if (sub !== 'push' && !(sub === undefined && mayExpandToAny(run.marked[at] as string, ['push'])))
    return false
  const end = pushOptionsEnd(run.resolved, at + 1, i => mayFormValueOption(run.marked[i] as string))
  return run.marked.slice(at + 1, end).some(word => mayExpandToAny(word, HOOK_SKIPS))
}

/** A glob or brace led by `-`, or one that may match `-o`, may be an option that takes the next `--` as its value. */
const mayFormValueOption = (marked: string): boolean =>
  GLOB_OR_GROUP.test(marked) && (unmark(marked).startsWith('-') || mayExpandToAny(marked, ['-o']))
