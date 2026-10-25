import { INCLUDE_KEY } from './git-include.js'
import { NO_VERIFY } from './push-words.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * The words that drop the pre-push hook beside a git subcommand: `--no-verify`, and a key that
 * sets `core.hooksPath`, an alias or an include, as a `-c` value or a `git config` key.
 */

/** A config key that overrides the guard outright, whatever its value. */
export const GUARD_KEY = /^(?:core\.hookspath|alias\..*)$/i

const HOOK_KEY_STARTS = ['core.hookspath', 'alias.', 'include.path', 'includeif.']

const dropsHook = (word: string): boolean =>
  NO_VERIFY.test(word) || [GUARD_KEY, INCLUDE_KEY].some(key => key.test(word.split('=')[0] as string))

/**
 * Whether a marked word is, or may expand to, a word that drops the hook (CC-1322). A word with an
 * expansion counts when its literal start could begin one, as `core.hooks$K` or `--no-$V`; one that
 * opens with an expansion is left to the checks that read splitting words.
 */
export function mayDropHook(marked: string): boolean {
  if (!marked.includes(LIVE)) return dropsHook(unmark(marked))
  const prefix = unmark(marked.slice(0, marked.indexOf(LIVE))).toLowerCase()
  if (prefix === '') return false
  return ['--no-verify', ...HOOK_KEY_STARTS].some(
    start => start.startsWith(prefix) || prefix.startsWith(start),
  )
}
