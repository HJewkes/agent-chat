/**
 * Text a shell runs later than the line that holds it (CC-1334): a `trap` action, an `alias` value, and
 * a `.`, `source` or shell script read from a stream. The guard checks each as a command line of its
 * own. These readers only find the text; which commands they apply to and what to deny is the guard's
 * question. `trapActions` and `aliasDefinitions` take either `words` or `marked` and return the same
 * kind, so a caller passing `marked` can tell a value the shell expands from one it can read.
 */
import path from 'node:path'
import { LIVE, unmark, type SimpleCommand } from './shell-words.js'

/** An alias the shell may expand at a later word: its name, its value, and where the shell expands it. */
export interface AliasDefinition {
  name: string
  value: string
  /** zsh `-g`: expanded in any word position, so `git X` can become `git push`. */
  global: boolean
  /** zsh `-s`: run for any word ending in `.name`, as `value word`. */
  suffix: boolean
  /** Ends in a blank, so the shell also expands the word after it as an alias. */
  blank: boolean
}

const OPTION = /^[-+][A-Za-z]+$/
// bash's -p and -l and bash 5.3's -P print traps; none sets one.
const TRAP_PRINT = /^-[A-Za-z]*[plP]/
// A signal named on its own resets it: EXIT, SIGINT, 0, RTMIN+1.
const SIGNAL = /^(?:SIG)?[A-Za-z0-9]+(?:[+-][0-9]+)?$/

// A leading `~/` or `~user/` expands to a home directory, which settles where the word points.
const HOME_TILDE = /^\0~(?:[A-Za-z_][\w.-]*)?(?=\/|$)/

/**
 * The shell settles this word at run time, so its literal text says nothing about it. Every reader here
 * gives such a word its fail-closed reading: a possible action, definition, blank end or stream.
 */
const isLive = (word: string): boolean => word.replace(HOME_TILDE, '').includes(LIVE)

/** The words after the leading options of `words`, which start at the command word, and those options. */
function splitOptions(words: readonly string[]): { options: string[]; operands: string[] } {
  let at = 1
  while (at < words.length && OPTION.test(unmark(words[at] ?? ''))) at++
  const options = words.slice(1, at).map(unmark)
  const operands = unmark(words[at] ?? '') === '--' ? words.slice(at + 1) : words.slice(at)
  return { options, operands }
}

/**
 * The actions a `trap` sets, for any signal. Empty when it prints (`-p`, `-l`), resets (`trap - EXIT`,
 * `trap EXIT`) or ignores (`trap '' INT`). A first operand the shell expands may be an option or several
 * fields, so then every operand is returned.
 */
export function trapActions(words: readonly string[]): string[] {
  if (unmark(words[0] ?? '') !== 'trap') return []
  const { options, operands } = splitOptions(words)
  const [first, ...signals] = operands
  if (first === undefined || options.some(option => TRAP_PRINT.test(option))) return []
  if (isLive(first)) return [...operands]
  const action = unmark(first)
  if (action === '' || action === '-') return []
  return signals.length === 0 && SIGNAL.test(action) ? [] : [first]
}

const hasFlag = (options: string[], flag: string): boolean =>
  options.some(option => option.startsWith('-') && option.includes(flag))

/** The text before an operand's first `=`, which the shell reads as the alias name, or all of it. */
function namePart(word: string): string {
  const eq = word.indexOf('=')
  return eq < 0 ? word : word.slice(0, eq)
}

/** An operand whose expansion may hold the `=` that splits name from value, so the shell may define anything. */
const hiddenDefinition = (word: string): AliasDefinition => ({
  name: word,
  value: word,
  global: true,
  suffix: true,
  blank: true,
})

/**
 * For each operand, whether one before it may have expanded to `-g` or `-s`: a live name part while every
 * operand before it was live too, since a settled one ends the options (`{-g,a=b}`, `${=X}=y`, `$E $G`).
 */
function flagsUnsure(operands: readonly string[]): boolean[] {
  let open = true
  let unsure = false
  return operands.map(word => {
    const before = unsure
    const live = isLive(namePart(word))
    unsure ||= open && live
    open &&= live
    return before
  })
}

/**
 * The definitions an `alias` makes, in bash or zsh, skipping the bare names it prints. `-g` and `-s` mark
 * them global or suffix, as does a live operand that may have expanded to either flag. An operand whose
 * name part is live may expand to any definition, so it is returned whole, as its own name and value.
 */
export function aliasDefinitions(words: readonly string[]): AliasDefinition[] {
  if (unmark(words[0] ?? '') !== 'alias') return []
  const { options, operands } = splitOptions(words)
  const unsure = flagsUnsure(operands)
  return operands.flatMap((word, at) => {
    if (isLive(namePart(word))) return [hiddenDefinition(word)]
    const eq = word.indexOf('=')
    if (eq < 0) return []
    const value = word.slice(eq + 1)
    const global = unsure[at] === true || hasFlag(options, 'g')
    const suffix = unsure[at] === true || hasFlag(options, 's')
    const blank = isLive(value) || /[ \t\n]$/.test(unmark(value))
    return [{ name: word.slice(0, eq), value, global, suffix, blank }]
  })
}

// The last part of a stream path, which a `~` or a cwd the shell sets at run time can put under /dev or /proc.
const STREAM_TAIL = /(?:^|\/)(?:stdin|stdout|stderr|tty\w*|console|environ|cmdline|comm|\d+|fd\/[^/]+)$/
// A `~`, `~user`, `~+` or `~-` with no `/` after it is a directory the shell picks at run time, all of it.
const BARE_TILDE = /^~[^/]*$/

/**
 * Whether a path may read a stream. Under /dev every node but /dev/null counts (stdin, fds, ttys, pts,
 * console), and under /proc every path does, since `root`, `cwd` and `fd` there link anywhere. A `~` or
 * relative path has a base the shell sets at run time (HOME, the cwd), so it counts when it is the bare
 * base, climbs with `..`, starts at `dev` or `proc`, or ends like a stream. Normalising first would let
 * `~/../..` cancel the `~`.
 */
function isStreamPath(word: string): boolean {
  if (word === '-' || BARE_TILDE.test(word)) return true
  const normal = path.posix.normalize(word)
  if (word.startsWith('/')) return isDeviceOrProc(normal)
  if (word.split('/').includes('..') || /^(?:dev|proc)(?:\/|$)/.test(normal)) return true
  return STREAM_TAIL.test(normal)
}

const isDeviceOrProc = (normal: string): boolean =>
  normal.startsWith('/proc/') || (normal.startsWith('/dev/') && normal !== '/dev/null')

/**
 * Whether any operand of `cmd` may name a stream rather than a file: a /dev node but /dev/null, any
 * /proc path, `-`, a `~` or relative path that may resolve to one, or any word the shell settles at run time. That
 * includes `<(…)` and `>(…)`, which leave a word that is only a mark, zsh's `=(…)`, and `. "$F"`. It reads
 * every operand, so `diff <(a) <(b)` is true too; the guard asks only of a shell, `.` or `source`.
 */
export function streamScript(cmd: SimpleCommand): boolean {
  return cmd.marked.some((marked, at) => at > 0 && (isLive(marked) || isStreamPath(unmark(marked))))
}
