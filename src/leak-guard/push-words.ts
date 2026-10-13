import { expandsToWords } from './git-unresolved.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * Whether a `git push` word is, or may become, `--no-verify` (CC-1285). Git stops reading options
 * at a literal `--`, so only the words before it matter, unless an option such as `-o` takes the
 * `--` as its value.
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
    if (word === undefined) {
      if (mayBecomeFlag(marked[i] ?? LIVE, splits)) return 'unreadable'
      continue
    }
    if (word === '--') return undefined
    if (NO_VERIFY.test(word)) return 'flag'
    if (!takesValue(word)) continue
    i++
    if (i < marked.length && resolved[i] === undefined) return 'unreadable'
  }
  return undefined
}

// `git push -h` on git 2.53: the options that take their value as the next word, even when it is `--`.
const VALUE_OPTIONS = ['--repo', '--recurse-submodules', '--receive-pack', '--exec', '--push-option']
const SHORT_VALUE = /^-[46dfnquv]*o$/

/** An option that takes the next word as its value; git accepts any unique abbreviation of a long one. */
const takesValue = (word: string): boolean =>
  SHORT_VALUE.test(word) || (word.length > 2 && VALUE_OPTIONS.some(option => option.startsWith(word)))

/** A word that may split into several, or whose literal text before its first expansion could begin the flag. */
function mayBecomeFlag(marked: string, splits: readonly string[]): boolean {
  if (expandsToWords(marked, splits)) return true
  const prefix = unmark(marked.slice(0, Math.max(0, marked.indexOf(LIVE))))
  return '--no-verify'.startsWith(prefix)
}
