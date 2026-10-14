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

/** An operand whose expansion may hold the `=` that splits name from value, so the shell may define anything. */
function hiddenDefinition(word: string): AliasDefinition | undefined {
  const eq = word.indexOf('=')
  if (!isLive(eq < 0 ? word : word.slice(0, eq))) return undefined
  return { name: word, value: word, global: true, suffix: true, blank: true }
}

/**
 * The definitions an `alias` makes, in bash or zsh, skipping the bare names it prints. `-g` and `-s` mark
 * them global or suffix. A first operand the shell expands might be either flag, so it marks them both,
 * and an operand that may expand to a definition is returned whole, as its own name and value.
 */
export function aliasDefinitions(words: readonly string[]): AliasDefinition[] {
  if (unmark(words[0] ?? '') !== 'alias') return []
  const { options, operands } = splitOptions(words)
  const first = operands[0] ?? ''
  const unsure = isLive(first) && !first.includes('=')
  const global = unsure || hasFlag(options, 'g')
  const suffix = unsure || hasFlag(options, 's')
  return operands.flatMap(word => {
    const hidden = hiddenDefinition(word)
    if (hidden !== undefined) return [hidden]
    const eq = word.indexOf('=')
    if (eq < 0) return []
    const value = word.slice(eq + 1)
    const blank = isLive(value) || /[ \t\n]$/.test(unmark(value))
    return [{ name: word.slice(0, eq), value, global, suffix, blank }]
  })
}

// `source /dev/stderr 2< <(…)` reads a script from any descriptor, so every standard stream counts.
const STREAM_PATH = /^\/dev\/(?:stdin|stdout|stderr|fd\/.+)$|^\/proc\/[^/]+\/fd\/.+$/

const isStreamPath = (word: string): boolean => word === '-' || STREAM_PATH.test(path.posix.normalize(word))

/**
 * Whether any operand of `cmd` may name a stream rather than a file: `/dev/stdin`, `/dev/stdout`,
 * `/dev/stderr`, `/dev/fd/N`, `/proc/<pid>/fd/N`, `-`, or any word the shell settles at run time. That
 * includes `<(…)` and `>(…)`, which leave a word that is only a mark, zsh's `=(…)`, and `. "$F"`. It reads
 * every operand, so `diff <(a) <(b)` is true too; the guard asks only of a shell, `.` or `source`.
 */
export function streamScript(cmd: SimpleCommand): boolean {
  return cmd.marked.some((marked, at) => at > 0 && (isLive(marked) || isStreamPath(unmark(marked))))
}
