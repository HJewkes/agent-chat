import { LIVE, unmark } from './shell-words.js'

/**
 * Words the guard cannot read because the shell fills them from an earlier command (CC-1287):
 * `$_` holds the previous command's last argument and `cd` sets `$PWD` and `$OLDPWD` from its
 * own, so `true --no-verify; git push origin "$_"` pushes with `--no-verify`. History expansion
 * and `fc` go further and rewrite the line's text before the shell parses it.
 */

// The name must follow `$` or `${` and its flags directly, so `${X:-_}` and `$MY_PWD` do not match;
// zsh's `$=_` and `${(L)_}` flags and bash's `${#_}` and `${!_}` still read the carrier.
const CARRIER = new RegExp(
  `${LIVE}\\$(?:[=~^]*(?:_|PWD|OLDPWD)(?![A-Za-z0-9_])|\\{(?:[=~^#!]|\\([^)]*\\))*(?:_|PWD|OLDPWD)(?![A-Za-z0-9_]))`,
)
// A short option cluster that turns on bash's `!` history expansion.
const HISTEXPAND_CLUSTER = /^-[A-Za-z]*H/
// An `fc` listing, the one form that prints history without running it.
const LISTING = /^-[A-Za-z]*l[A-Za-z]*$/

/** Whether a marked word expands `$_`, `$PWD` or `$OLDPWD`; quoting is ignored, since `"$_"` alone can be an option. */
export function readsLastArg(marked: string): boolean {
  return CARRIER.test(marked)
}

/** Whether the command `name` with marked arguments `marked` runs or enables text from the shell's history. */
export function runsHistory(name: string, marked: readonly string[]): boolean {
  if (name === 'r') return true
  if (name === 'fc') return !LISTING.test(marked[0] ?? '')
  if (name !== 'set') return false
  return marked.some(
    word => word.includes(LIVE) || HISTEXPAND_CLUSTER.test(word) || unmark(word) === 'histexpand',
  )
}
