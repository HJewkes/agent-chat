import { expandsToWords } from './git-unresolved.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * Whether a `git push` word is, or may become, `--no-verify` (CC-1285). Git stops reading options
 * at a literal `--`, so only the words before it matter.
 */

export const NO_VERIFY = /^--no-veri(?:f|fy)?$/

/** `flag` when a word resolves to `--no-verify`, `unreadable` when the guard cannot tell it does not. */
export type PushWordRisk = 'flag' | 'unreadable'

/**
 * The risk of push's words after `at`, the index of `push`. `resolved[i]` is the word as the shell
 * expands it, or undefined if the guard cannot tell; `marked[i]` is the same word marked with LIVE.
 */
export function pushWordRisk(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
  at: number,
): PushWordRisk | undefined {
  for (let i = at + 1; i < marked.length; i++) {
    const word = resolved[i]
    if (word === '--') return undefined
    if (word !== undefined) {
      if (NO_VERIFY.test(word)) return 'flag'
      continue
    }
    if (mayBecomeFlag(marked[i] ?? LIVE, splits)) return 'unreadable'
  }
  return undefined
}

/** A word that may split into several, or whose literal text before its first expansion could begin the flag. */
function mayBecomeFlag(marked: string, splits: readonly string[]): boolean {
  if (expandsToWords(marked, splits)) return true
  const prefix = unmark(marked.slice(0, Math.max(0, marked.indexOf(LIVE))))
  return '--no-verify'.startsWith(prefix)
}
