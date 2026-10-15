/**
 * Reads a shell invocation (`sh`, `ash`, `bash`, `dash`, `ksh`, `zsh`) the way the shell does (CC-1288):
 * options and their operands first, then the `-c` string, a script file or stdin. It also reports
 * whether the options may turn on `!` history, which rewrites a script read from stdin or a file
 * after the guard has read it. Observed in bash 5.3 and zsh 5.9: `-i`, or the history list together
 * with histexpand, expands `!$` in such a script. The options leave a `-c` string inert, but the
 * string can turn history on itself (`set -H -o history`), so a caller must still check it.
 * Anything the walk cannot read fails closed: an expanded word is `hidden` and reports history.
 *
 * Every spelling of an option (`-s`, `-o shin_stdin`, `-oshinstdin`, `--stdin`, `+o noshinstdin`,
 * `+-noshinstdin`) resolves to one name in its shell's grammar, and the walk reads only the effect
 * that name has, so a spelling cannot reach an option without reaching its effect.
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
  /**
   * The index in the words of a startup file (`--rcfile F`, `--init-file F`) the shell runs before its
   * script, set when the options may make it interactive. bash runs it under `-i` and `-ic` (observed).
   */
  rcfile?: number
}

/**
 * What an option does to the script source: read stdin, run the operand, turn on history, end the
 * options, or hide the call where the shells a name may stand for read it differently.
 */
type Effect = 'stdin' | 'command' | 'history' | 'end' | 'hidden'

/** A short letter: the option name it sets, and how its sign reads. */
interface Letter {
  name: string
  /** zsh's `-K` turns BANG_HIST off and `+K` turns it on. */
  inverted?: boolean
  /** Observed to take effect under `+` as well as `-`, as `bash +c`, `bash +s` and `zsh +b` do. */
  anySign?: boolean
  /** Under `+` the shells the name may stand for disagree (`sh +s`: bash reads stdin, dash the file). */
  plusHides?: boolean
}

/**
 * How a letter that takes an option name reads it when more letters follow it in its word: `rest`
 * takes them as the name (zsh's `-ointeractive`), `next` takes the next word and reads them as flags
 * (bash's `-oi pipefail`), and `unread` hides the call, since either reading may be wrong. A letter
 * alone in its word takes the next word as its name under every rule.
 */
type NameRule = 'rest' | 'next' | 'unread'

/** One shell's option grammar. Nothing about the options is shared between shells except through this record. */
interface Grammar {
  letters: Readonly<Record<string, Letter>>
  /** The letters that take an option name, and how each reads it. */
  named: Readonly<Record<string, NameRule>>
  /** Words that end the options. zsh also ends them at a bare `+` or `+-`, which bash ignores or rejects. */
  ends: ReadonlySet<string>
  /** Words that hide the call, because the shells a name may stand for read them differently. */
  hides?: ReadonlySet<string>
  /** Long options that take the next word as their operand, and whether it names a startup file. */
  longOperands: Readonly<Record<string, 'rcfile' | 'operand'>>
  /**
   * What runs when both `-s` and `-c` are on: bash and zsh run only the string, dash runs the string
   * and then stdin (observed), which no single script source describes.
   */
  stdinWithCommand: 'command' | 'hidden'
}

// Names for letters that have no long spelling. `normalise` strips `-`, so no long option reaches them.
const COMMAND = '-c'
const END = '-b'

/**
 * One table for every shell, keyed by the zsh-normalised name. A shell that does not know a name
 * exits before it reads any script (`bash -o stdin`), so a name another shell owns fails closed.
 * `login` counts as history because the profile files it reads can run `set -o history`.
 */
const NAMES: Readonly<Record<string, Effect>> = {
  [COMMAND]: 'command',
  [END]: 'end',
  shinstdin: 'stdin',
  stdin: 'stdin',
  interactive: 'history',
  history: 'history',
  histexpand: 'history',
  banghist: 'history',
  login: 'history',
}

const COMMON_LETTERS: Readonly<Record<string, Letter>> = {
  c: { name: COMMAND, anySign: true },
  s: { name: 'shinstdin' },
  i: { name: 'interactive' },
  l: { name: 'login' },
}
const BASH_LETTERS = { ...COMMON_LETTERS, s: { name: 'shinstdin', anySign: true }, H: { name: 'histexpand' } }

const DASH_ENDS = new Set(['-', '--'])

const BASH_LONG = { '--rcfile': 'rcfile', '--init-file': 'rcfile' } as const

// Observed grammars: zsh 5.9, bash 5.3, dash and busybox 1.37's ash. zsh's `-O` is a plain flag and dash
// rejects it. `sh` may be bash, dash or busybox's ash, and `ash` is busybox's: both take bash's letters,
// which dash rejects where it is wider (`-O`), and hide the call where the shells read the script source
// differently: `+s`, `-s` with `-c`, and `--rcfile` or `--init-file`, whose operand bash takes as the
// startup file while busybox ignores the option and reads the next word (`ash --rcfile -c x` runs `x`).
const SH: Grammar = {
  letters: { ...BASH_LETTERS, s: { name: 'shinstdin', plusHides: true } },
  named: { o: 'next', O: 'next' },
  ends: DASH_ENDS,
  hides: new Set(Object.keys(BASH_LONG)),
  longOperands: {},
  stdinWithCommand: 'hidden',
}

const GRAMMARS: Readonly<Record<string, Grammar>> = {
  zsh: {
    letters: {
      ...COMMON_LETTERS,
      K: { name: 'banghist', inverted: true },
      b: { name: END, anySign: true },
    },
    named: { o: 'rest' },
    ends: new Set([...DASH_ENDS, '+', '+-']),
    longOperands: { '--emulate': 'operand' },
    stdinWithCommand: 'command',
  },
  bash: {
    letters: BASH_LETTERS,
    named: { o: 'next', O: 'next' },
    ends: DASH_ENDS,
    longOperands: BASH_LONG,
    stdinWithCommand: 'command',
  },
  sh: SH,
  ash: SH,
  dash: {
    letters: COMMON_LETTERS,
    named: { o: 'next' },
    ends: DASH_ENDS,
    longOperands: {},
    stdinWithCommand: 'hidden',
  },
}

// Any other shell takes every letter's effect under either sign, hides a name glued to `o` or `O`, hides a
// bare `+` or `+-`, which zsh reads as the end of the options and bash ignores, and reports history even
// under `-c`: nothing shows its `-c` string is inert, and csh substitutes `!` in the text it reads.
const UNOBSERVED: Grammar = {
  letters: {
    ...BASH_LETTERS,
    i: { name: 'interactive', anySign: true },
    K: { name: 'banghist', inverted: true },
  },
  named: { o: 'unread', O: 'unread' },
  ends: DASH_ENDS,
  hides: new Set(['+', '+-']),
  longOperands: { ...BASH_LONG, '--emulate': 'operand' },
  stdinWithCommand: 'hidden',
}

// `SHELLOPTS` can turn on history and histexpand before the script is read, and a startup file named
// by `BASH_ENV` or `ENV` can run `set -H -o history` first; each fails closed whatever its value.
const STARTUP_ASSIGNMENT = /^(?:SHELLOPTS|BASH_ENV|ENV)=/
// A long option: `--name`, or zsh's `+-name`, which turns it off.
const LONG = /^(?:--|\+-)./

/** zsh ignores case, `_` and `-` in an option name (observed: `SHIN_STDIN`, `shin-stdin`). */
const normalise = (name: string): string => name.toLowerCase().replaceAll(/[_-]/g, '')

/** The effect of a named option turned on or off; one `no` prefix inverts it, as in zsh. */
function nameEffect(name: string, on: boolean): Effect | undefined {
  const plain = normalise(name)
  const direct = NAMES[plain]
  if (direct !== undefined) return on ? direct : undefined
  const negated = plain.startsWith('no') ? NAMES[plain.slice(2)] : undefined
  return on ? undefined : negated
}

function letterEffect(grammar: Grammar, letter: string, on: boolean): Effect | undefined {
  const known = grammar.letters[letter]
  if (known === undefined) return undefined
  if (!on && known.plusHides === true) return 'hidden'
  return known.anySign === true || on !== (known.inverted === true) ? NAMES[known.name] : undefined
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
  /** The index of the last `--rcfile` or `--init-file` operand. */
  rcfile?: number
}

function apply(effect: Effect | undefined, opts: Options): void {
  if (effect === 'stdin') opts.stdin = true
  else if (effect === 'command') opts.command = true
  else if (effect === 'history') opts.history = true
  else if (effect === 'end') opts.ended = true
  else if (effect === 'hidden') opts.hidden = true
}

/** Reads an option name: its effect, or a hidden call when the shell expands it. */
function readName(operand: string | undefined, on: boolean, opts: Options): void {
  if (operand?.includes(LIVE)) opts.hidden = true
  else if (operand !== undefined) apply(nameEffect(operand, on), opts)
}

/** Reads one short cluster such as `-eo pipefail`, `-ointeractive` or `+o`, consuming any operand words. */
function readCluster(grammar: Grammar, words: readonly string[], at: number, opts: Options): number {
  const word = words[at] ?? ''
  const on = word.startsWith('-')
  let next = at + 1
  for (let i = 1; i < word.length; i++) {
    const letter = word[i] ?? ''
    const rest = word.slice(i + 1)
    const rule = grammar.named[letter]
    if (rule === undefined) apply(letterEffect(grammar, letter, on), opts)
    else if (rest === '' || rule === 'next') readName(words[next++], on, opts)
    else {
      if (rule === 'rest') readName(rest, on, opts)
      else opts.hidden = true
      return next
    }
  }
  return next
}

/** Reads `--name` or zsh's `+-name`, which turns the option off; returns the next index. */
function readLong(grammar: Grammar, words: readonly string[], at: number, opts: Options): number {
  const word = words[at] ?? ''
  const kind = grammar.longOperands[word]
  if (kind === undefined) {
    readName(word.slice(2), word.startsWith('-'), opts)
    return at + 1
  }
  if (words[at + 1]?.includes(LIVE)) opts.hidden = true
  if (kind === 'rcfile' && at + 1 < words.length) opts.rcfile = at + 1
  return at + 2
}

/** Walks the option words, stopping at the first operand, `--`, `-b`, or a word the shell expands. */
function readOptions(grammar: Grammar, words: readonly string[]): Options {
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
    if (word.includes(LIVE) || grammar.hides?.has(word)) return { ...opts, end: at, hidden: true }
    if (grammar.ends.has(word)) return { ...opts, end: at + 1 }
    if (!word.startsWith('-') && !word.startsWith('+')) return { ...opts, end: at }
    at = LONG.test(word) ? readLong(grammar, words, at, opts) : readCluster(grammar, words, at, opts)
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
  const grammar = GRAMMARS[name] ?? UNOBSERVED
  const opts = readOptions(grammar, marked)
  const call = readScript(grammar, opts, marked, assigns)
  return opts.history && opts.rcfile !== undefined ? { ...call, rcfile: opts.rcfile } : call
}

function readScript(
  grammar: Grammar,
  opts: Options,
  marked: readonly string[],
  assigns: readonly string[],
): ShellCall {
  const both = opts.command && opts.stdin && grammar.stdinWithCommand === 'hidden'
  if (opts.hidden || both) return { script: { from: 'hidden' }, history: true }
  if (opts.command)
    return {
      script: { from: 'command', at: opts.end < marked.length ? opts.end : undefined },
      history: grammar === UNOBSERVED,
    }
  const history = opts.history || assigns.some(word => STARTUP_ASSIGNMENT.test(word))
  if (opts.stdin || opts.end >= marked.length) return { script: { from: 'stdin' }, history }
  return { script: { from: 'file', at: opts.end }, history }
}
