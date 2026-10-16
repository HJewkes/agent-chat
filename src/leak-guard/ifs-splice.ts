import { LIVE } from './shell-words.js'

/**
 * An unquoted `$IFS` in a word lets the shell split it into words the guard never sees, such as
 * `main$IFS--no-verify` becoming `main --no-verify` (CC-1284). The guard does not model how a
 * word splits, so it treats any such reference as a splice.
 */

// zsh's `$=IFS` and `${=IFS}` force splitting, and `~` and `^` may sit beside `=`. A bare `$IFS` has
// no name guard after it: quote removal turns `$IFS''push` into `$IFSpush`, so the guard fails closed.
const IFS_REFERENCE = new RegExp(
  `${LIVE}\\$(?:[=~^]*IFS|\\{[^}]*?(?<![A-Za-z0-9_])IFS(?![A-Za-z0-9_])[^}]*\\})`,
)

/** Whether the shell may split the marked word at an unquoted `$IFS`, `${IFS…}`, `$=IFS` or `${=IFS}`. */
export const splicesIfs = (marked: string, splits: readonly string[]): boolean =>
  splits.includes(marked) && IFS_REFERENCE.test(marked)
