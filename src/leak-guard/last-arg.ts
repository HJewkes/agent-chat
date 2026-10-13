import { LIVE, unmark } from './shell-words.js'

/**
 * Words the guard cannot read because the shell fills them from an earlier command (CC-1287):
 * `$_` holds the previous command's last argument and `cd` sets `$PWD` and `$OLDPWD` from its
 * own, so `true --no-verify; git push origin "$_"` pushes with `--no-verify`. History expansion
 * and `fc` go further and rewrite the line's text before the shell parses it.
 */

const CARRIER = '(?:_|PWD|OLDPWD)(?![A-Za-z0-9_])'
// A carrier straight after `$` or `${` and their flags, anywhere in the word, so one nested in an
// operand (`${X:-$_}`) or a zsh nested head (`${${_}}`) counts; `${X:-_}` and `$MY_PWD` do not.
const CARRIER_HEAD = new RegExp(`\\$(?:[=~^]*|\\{[=~^#!]*)${CARRIER}`)
// A zsh flag group's delimiters can be any character, `${(s:):)_}`, so a carrier anywhere after one counts.
const CARRIER_AFTER_FLAGS = new RegExp(`\\$\\{\\([^}]*(?<![A-Za-z0-9_])${CARRIER}`)
// An `fc` word that only lists: `-l`, `-n` or `-r` clusters, `-5`, `--` or a literal operand.
const LISTING_WORD = /^(?:-[lnr]+|-?\d+|--|[^-].*)$/
// The cluster that makes `fc` list rather than edit and run.
const LIST_CLUSTER = /^-[nr]*l[lnr]*$/
const SET_HISTEXPAND = /^-[A-Za-z]*H/

/** Whether a marked word expands `$_`, `$PWD` or `$OLDPWD` at any depth; quoting is ignored, since `"$_"` alone can be an option. */
export function readsLastArg(marked: string): boolean {
  const live = marked.indexOf(LIVE)
  if (live < 0) return false
  const text = unmark(marked.slice(live))
  return CARRIER_HEAD.test(text) || CARRIER_AFTER_FLAGS.test(text)
}

/** Whether `fc` with these words only lists: every word literal, none an `-s` or `-e`, and some cluster holds `l`. */
function fcOnlyLists(marked: readonly string[]): boolean {
  if (marked.some(word => word.includes(LIVE) || !LISTING_WORD.test(word))) return false
  return marked.some(word => LIST_CLUSTER.test(word))
}

/** Whether a `set` or `shopt` word may turn on `!` history expansion. */
function enablesHistexpand(name: string, word: string): boolean {
  if (word.includes(LIVE) || word.includes('histexpand')) return true
  return name === 'set' && SET_HISTEXPAND.test(word)
}

/** Whether the command `name` with marked arguments `marked` runs or enables text from the shell's history. */
export function runsHistory(name: string, marked: readonly string[]): boolean {
  if (name === 'r') return true
  if (name === 'fc') return !fcOnlyLists(marked)
  if (name !== 'set' && name !== 'shopt') return false
  return marked.some(word => enablesHistexpand(name, word))
}
