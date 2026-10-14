/**
 * Reads a shell invocation (`sh`, `bash`, `dash`, `ksh`, `zsh`) the way the shell does (CC-1288):
 * options and their operands first, then the `-c` string, a script file or stdin. It also reports
 * whether the options may turn on `!` history, which rewrites a script read from stdin or a file
 * after the guard has read it. Observed in bash 5.3 and zsh 5.9: `-i`, or the history list together
 * with histexpand, expands `!$` in such a script. The options leave a `-c` string inert, but the
 * string can turn history on itself (`set -H -o history`), so a caller must still check it.
 * Anything the walk cannot read fails closed: an expanded word is `hidden` and reports history.
 */
import { LIVE } from './shell-words.js'

export type ShellScript =
  /** `at` indexes the `-c` string in the words, undefined when none follows. */
  | { from: 'command'; at: number | undefined }
  | { from: 'stdin' }
  | { from: 'file'; at: number }
  /** An option word the shell expands, so which script runs is unknown. */
  | { from: 'hidden' }

export interface ShellCall {
  script: ShellScript
  history: boolean
}

// Option names that turn on the history list, `!` expansion or interactive mode, after `normalise`.
const HISTORY_OPTION = /^(?:history|histexpand|interactive|banghist)$/
// Long options that take the next word as their operand: bash's rc files and zsh's `--emulate`.
const LONG_WITH_OPERAND = new Set(['--rcfile', '--init-file', '--emulate'])
// A `SHELLOPTS` assignment can turn on history and histexpand before the script is read.
const SHELLOPTS = /^SHELLOPTS=/
// A long option: `--name`, or zsh's `+-name`, which turns it off.
const LONG = /^(?:--|\+-)./
// Shells observed to take an `o`'s name from the next word even when letters follow it in the cluster.
const NEXT_WORD_NAME = new Set(['sh', 'bash', 'dash'])

/** zsh accepts `BANG_HIST`, `bang-hist` and `banghist` alike, and a `no` prefix inverts the option. */
function turnsOnHistory(name: string, on: boolean): boolean {
  const plain = name.toLowerCase().replaceAll(/[_-]/g, '')
  if (HISTORY_OPTION.test(plain)) return on
  return plain.startsWith('no') && HISTORY_OPTION.test(plain.slice(2)) && !on
}

interface Options {
  /** The index of the first operand, or of the word that hides the rest. */
  end: number
  hidden: boolean
  command: boolean
  stdin: boolean
  history: boolean
  /** zsh's `-b` ends the options after the word that holds it. */
  ended: boolean
}

/** Reads an option name: on, off, or an expansion that hides it. */
function readOptionName(operand: string | undefined, on: boolean, opts: Options): void {
  if (operand?.includes(LIVE)) opts.hidden = true
  else if (operand !== undefined && turnsOnHistory(operand, on)) opts.history = true
}

/**
 * Reads one short cluster such as `-eo pipefail` or `+o`, consuming any operand words. zsh takes the
 * rest of the word after `o` as the name (`-ointeractive`); bash and dash take the next word and keep
 * reading the letters after `o` as flags (`bash -oi pipefail` is interactive). For any other shell the
 * letters after `o` may be either, so they are read as flags and also report history.
 */
function readCluster(name: string, words: readonly string[], at: number, opts: Options): number {
  const word = words[at] ?? ''
  const on = word.startsWith('-')
  let next = at + 1
  for (let i = 1; i < word.length; i++) {
    const letter = word[i]
    const rest = word.slice(i + 1)
    if (letter === 'o' || letter === 'O') {
      if (name === 'zsh' && rest !== '') {
        readOptionName(rest, on, opts)
        return next
      }
      readOptionName(words[next++], on, opts)
      if (!NEXT_WORD_NAME.has(name) && rest !== '') opts.history = true
    } else if (letter === 'c') opts.command = true
    else if (letter === 's') opts.stdin = true
    else if (on && (letter === 'i' || letter === 'H')) opts.history = true
    else if (!on && name === 'zsh' && letter === 'K') opts.history = true
    else if (name === 'zsh' && letter === 'b') opts.ended = true
  }
  return next
}

/** Reads `--name` or zsh's `+-name`, which turns the option off; returns the next index. */
function readLong(words: readonly string[], at: number, opts: Options): number {
  const word = words[at] ?? ''
  if (!LONG_WITH_OPERAND.has(word)) {
    opts.history ||= turnsOnHistory(word.slice(2), word.startsWith('-'))
    return at + 1
  }
  if (words[at + 1]?.includes(LIVE)) opts.hidden = true
  return at + 2
}

/** Walks the option words, stopping at the first operand, `--`, `-b`, or a word the shell expands. */
function readOptions(name: string, words: readonly string[]): Options {
  const opts: Options = {
    end: words.length,
    hidden: false,
    command: false,
    stdin: false,
    history: false,
    ended: false,
  }
  let at = 0
  while (at < words.length && !opts.hidden && !opts.ended) {
    const word = words[at] ?? ''
    if (word.includes(LIVE)) return { ...opts, end: at, hidden: true }
    if (word === '--' || word === '-') return { ...opts, end: at + 1 }
    if (!word.startsWith('-') && !word.startsWith('+')) return { ...opts, end: at }
    at = LONG.test(word) ? readLong(words, at, opts) : readCluster(name, words, at, opts)
  }
  return { ...opts, end: Math.min(at, words.length) }
}

/**
 * `name` is the shell's base name, `marked` its marked words after the name, and `assigns` the
 * `NAME=value` words the command runs with.
 */
export function readShellCall(
  name: string,
  marked: readonly string[],
  assigns: readonly string[],
): ShellCall {
  const opts = readOptions(name, marked)
  if (opts.hidden) return { script: { from: 'hidden' }, history: true }
  if (opts.command)
    return {
      script: { from: 'command', at: opts.end < marked.length ? opts.end : undefined },
      history: false,
    }
  const history = opts.history || assigns.some(word => SHELLOPTS.test(word))
  if (opts.stdin || opts.end >= marked.length) return { script: { from: 'stdin' }, history }
  return { script: { from: 'file', at: opts.end }, history }
}
