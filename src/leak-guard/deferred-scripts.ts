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

const isLive = (word: string): boolean => word.includes(LIVE)

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

/**
 * The definitions an `alias` makes, in bash or zsh, skipping the bare names it prints. `-g` and `-s` mark
 * them global or suffix. A first operand the shell expands might be either flag, so it marks them both.
 */
export function aliasDefinitions(words: readonly string[]): AliasDefinition[] {
  if (unmark(words[0] ?? '') !== 'alias') return []
  const { options, operands } = splitOptions(words)
  const first = operands[0] ?? ''
  const unsure = isLive(first) && !first.includes('=')
  const global = unsure || hasFlag(options, 'g')
  const suffix = unsure || hasFlag(options, 's')
  return operands.flatMap(word => {
    const eq = word.indexOf('=')
    if (eq < 0) return []
    const value = word.slice(eq + 1)
    return [{ name: word.slice(0, eq), value, global, suffix, blank: /[ \t\n]$/.test(unmark(value)) }]
  })
}

const STREAM_PATH = /^\/dev\/(?:stdin|fd\/.+)$|^\/proc\/[^/]+\/fd\/.+$/

/** `<(…)` and `>(…)` leave a word that is only a mark; zsh's `=(…)` leaves `=` and a mark. */
const isProcessSubstitution = (marked: string): boolean => marked === LIVE || /^\0?=\0$/.test(marked)

const isStreamPath = (word: string): boolean => word === '-' || STREAM_PATH.test(path.posix.normalize(word))

/**
 * Whether any operand of `cmd` names a stream rather than a file: a process substitution, `/dev/stdin`,
 * `/dev/fd/N`, `/proc/<pid>/fd/N` or `-`. A `$N` in an fd path counts, since any fd is a stream. It
 * reads every operand, so `diff <(a) <(b)` is true too; the guard asks only of a shell, `.` or `source`.
 */
export function streamScript(cmd: SimpleCommand): boolean {
  return cmd.marked.some(
    (marked, at) => at > 0 && (isProcessSubstitution(marked) || isStreamPath(unmark(marked))),
  )
}
