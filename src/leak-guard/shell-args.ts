import { LIVE, parseShell, type SimpleCommand } from './shell-words.js'

/**
 * Fills the positionals a `sh -c SCRIPT [ARG0 [ARGS...]]` script reads with the words the shell
 * binds to them (CC-1201), so the guard can check the script as the command line it becomes.
 * A word the guard cannot read becomes `$@`, which the guard already reads as "unreadable, may be
 * none or several", in the same quote context as the positional it replaces.
 *
 * The fill is literal only when the guard can see every way the script reads its arguments. A
 * script that may rebind, re-split or hide them, or that the scanner cannot fully lex, returns
 * `implicit` instead: teaching the scanner each shell's corner is a race the guard loses.
 */

/** One word bound to a positional; `undefined` when the guard cannot read it. */
export type ScriptArg = string | undefined

export interface ScriptArgs {
  /** `$0`: ARG0, or the shell's name when there is none. */
  zero: ScriptArg
  /** `$1` onwards: the words after ARG0. */
  params: readonly ScriptArg[]
  /** Whether further words may follow unseen: xargs appends, or a word expands to several. */
  more: boolean
}

/** The filled script, or the reason the guard cannot tell what the script makes of its arguments. */
export type ScriptFill = { text: string } | { implicit: string }

interface Use {
  start: number
  end: number
  name: string
  quoted: boolean
  modified: boolean
}

// `${N}` fills exactly; any other brace form (`${1:-x}`, `${#1}`, `${10}`, `${@:2}`) is modified.
const BRACED = /^\$\{[#!]?([0-9@*])[^}]*\}/
const EXACT = /^\$\{[0-9@*]\}/
// `$10` is `${1}0` in sh and the tenth argument in zsh, so a multi-digit read is modified.
const BARE = /^\$([0-9]+|[@*])/
// zsh's `$argv`, bash's `$BASH_ARGV`, indirect `${!#}` and zsh flags such as `${=1}` or `$=1`.
const ARRAY_NAMES = String.raw`(?:argv|BASH_ARGV)(?![A-Za-z0-9_])`
const OTHER_READ = new RegExp(
  String.raw`^\$(?:[=~^]+\S|${ARRAY_NAMES}|\{[#]?${ARRAY_NAMES}[^}]*\}|\{[^A-Za-z_#}][^}]*\})`,
)
// Restated from git-alias.ts, which does not export it; the empty word is plain too.
const FILL_PLAIN = /^[A-Za-z0-9_./:=@%+-]*$/
const UNREADABLE = '$@'
const BOUNDARY = /[\s;&|()<>]/
const WORD_START = /[\s;&|()]/

// Words that rebind, read or re-run the arguments wherever they appear (`echo shift` over-denies).
const READERS = new Set(['shift', 'getopts', 'eval', 'alias', 'trap', 'nameref'])
// A word whose dequoted form spells I, F and S in order may set IFS (`IF""S=.`, `declare -n r=IF""S`).
const MAY_NAME_IFS = /I.*F.*S/s
// A declaration with `-n` makes a nameref, through which an assignment reaches a variable the guard cannot name.
const DECLARERS = new Set(['declare', 'typeset', 'local', 'export', 'readonly'])
const NAMEREF_FLAG = /^[-+][A-Za-z]*n[A-Za-z]*$/
// Words a command word may follow; `command` and `builtin` run a builtin such as `shift`.
const PREFIXES = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time'])
const WRAPPERS = new Set(['command', 'builtin'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
const FUNCTION_DEF = /(?:^|[\s;&|(){}])(?:function\s|[A-Za-z_][\w-]*\s*\(\s*\))/
const SET_FLAGS = /^[-+][A-Za-z]+$/

/** The script with each positional it reads replaced by its word, or why the fill cannot be trusted. */
export function fillScriptArgs(script: string, args: ScriptArgs): ScriptFill {
  const implicit = implicitReader(script)
  if (implicit !== undefined) return { implicit }
  const uses = positionalUses(script)
  if (typeof uses === 'string') return { implicit: uses }
  let text = script
  for (const use of uses.reverse()) {
    const { start, end, words } = replacement(script, use, args)
    text = text.slice(0, start) + words + text.slice(end)
  }
  // An argument may spell a reader itself: `export "$0=."` with `$0` set to IFS.
  const filledReader = implicitReader(text)
  return filledReader === undefined ? { text } : { implicit: filledReader }
}

/** A reader the fill cannot follow: a function, or one of `commandReader`'s. */
function implicitReader(script: string): string | undefined {
  if (FUNCTION_DEF.test(script)) return 'function'
  for (const cmd of parseShell(script)) {
    const reader = commandReader(cmd)
    if (reader !== undefined) return reader
  }
  return undefined
}

/** A reader word, IFS, a nameref, a `set` that is not plain flags, `for NAME` without `in`, or a command word that expands. */
function commandReader({ words, marked }: SimpleCommand): string | undefined {
  const reader = words.find(word => READERS.has(word))
  if (reader !== undefined) return reader
  if (words.some(word => MAY_NAME_IFS.test(word))) return 'IFS'
  if (words.some(word => DECLARERS.has(word)) && marked.some(declaresUnseen)) return 'nameref'
  if (words.some((word, i) => word === 'set' && !plainSet(words.slice(i + 1)))) return 'set'
  const head = headIndex(words)
  if (head === undefined) return undefined
  if (marked[head]?.includes(LIVE)) return 'command word'
  if (words[head] === '.' || words[head] === 'source') return 'source'
  if (words[head] === 'function') return 'function'
  return words[head] === 'for' && words[head + 2] !== 'in' ? 'for' : undefined
}

/** A declaration word that makes a nameref, or whose flags or name expand, so it may make one or name IFS. */
function declaresUnseen(marked: string): boolean {
  const word = marked.replaceAll(LIVE, '')
  if (NAMEREF_FLAG.test(word)) return true
  return /^[-+]/.test(word) ? marked.includes(LIVE) : (marked.split('=')[0] ?? '').includes(LIVE)
}

/** The command word: past keywords, assignments and the builtin wrappers. */
function headIndex(words: readonly string[]): number | undefined {
  const i = words.findIndex(word => !PREFIXES.has(word) && !WRAPPERS.has(word) && !ASSIGNMENT.test(word))
  return i === -1 ? undefined : i
}

/** `set` with only flag clusters, each `-o` followed by an option name; anything else may set operands. */
function plainSet(rest: readonly string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? ''
    if (!SET_FLAGS.test(word)) return false
    if (word.endsWith('o') && !/^[a-z]+$/.test(rest[++i] ?? '')) return false
  }
  return true
}

/**
 * Every positional the script reads, outside single quotes, with its span; or why the scan cannot
 * be trusted: a comment, a heredoc, an unclosed quote, quoting nested in a backtick, a double-quoted
 * `$(...)` or a double-quoted `${...}`, which a flat scan misreads, or a `$'...'` string, which dash
 * reads as `$` and a single-quoted string.
 */
function positionalUses(script: string): Use[] | string {
  const uses: Use[] = []
  let quote: string | undefined
  for (let i = 0; i < script.length; i++) {
    const c = script[i]
    if (quote === "'") quote = c === "'" ? undefined : quote
    else if (c === '\\' || script.startsWith('$$', i)) i++
    else if (c === '`' || (quote === '"' && nestsQuotes(script, i))) return 'nested quoting'
    else if (quote === undefined && script.startsWith("$'", i)) return 'ansi-c quoting'
    else if (quote === undefined && script.startsWith('<<', i)) return 'heredoc'
    else if (quote === undefined && c === '#' && wordStart(script, i)) return 'comment'
    else if (c === '"') quote = quote === '"' ? undefined : '"'
    else if (c === "'" && quote === undefined) quote = "'"
    else if (c === '$') {
      const use = useAt(script, i, quote === '"')
      if (use === undefined) continue
      uses.push(use)
      i = use.end - 1
    }
  }
  return quote === undefined ? uses : 'unclosed quote'
}

/** A `$(` inside double quotes, or a `${` whose text before its `}` holds a quote. */
function nestsQuotes(script: string, i: number): boolean {
  if (script.startsWith('$(', i)) return true
  if (!script.startsWith('${', i)) return false
  const close = script.indexOf('}', i)
  return /["']/.test(script.slice(i, close === -1 ? undefined : close))
}

const wordStart = (script: string, i: number): boolean => i === 0 || WORD_START.test(script[i - 1] ?? '')

function useAt(script: string, start: number, quoted: boolean): Use | undefined {
  const rest = script.slice(start)
  const braced = BRACED.exec(rest)
  if (braced !== null) {
    const end = start + braced[0].length
    return { start, end, name: braced[1] ?? '', quoted, modified: !EXACT.test(rest) }
  }
  const bare = BARE.exec(rest)
  if (bare !== null) {
    const name = bare[1] ?? ''
    return { start, end: start + 1 + name.length, name, quoted, modified: name.length > 1 }
  }
  const other = OTHER_READ.exec(rest)
  return other === null
    ? undefined
    : { start, end: start + other[0].length, name: '', quoted, modified: true }
}

const plain = (word: ScriptArg): ScriptArg => (word !== undefined && FILL_PLAIN.test(word) ? word : undefined)

/** What one positional stands for: `$0`, `$1`...; past the end it is empty unless more may follow. */
function single(use: Use, args: ScriptArgs): ScriptArg {
  if (use.name === '0') return plain(args.zero)
  const n = Number(use.name)
  if (n > args.params.length) return args.more ? undefined : ''
  return plain(args.params[n - 1])
}

/** Every param for `$@`/`$*`, unless one is unreadable or more may follow. */
function allParams(args: ScriptArgs): string[] | undefined {
  if (args.more) return undefined
  const words = args.params.map(plain)
  return words.every(word => word !== undefined) ? (words as string[]) : undefined
}

/** A `"$@"` that is a whole word: its quotes hug it and a word boundary sits outside them. */
function wholeToken(script: string, use: Use): boolean {
  if (script[use.start - 1] !== '"' || script[use.end] !== '"') return false
  const before = script[use.start - 2]
  const after = script[use.end + 1]
  return (before === undefined || BOUNDARY.test(before)) && (after === undefined || BOUNDARY.test(after))
}

function replacement(
  script: string,
  use: Use,
  args: ScriptArgs,
): { start: number; end: number; words: string } {
  const at = (words: string) => ({ start: use.start, end: use.end, words })
  if (use.modified) return at(UNREADABLE)
  if (use.name !== '@' && use.name !== '*') return at(single(use, args) ?? UNREADABLE)
  const words = allParams(args)
  if (words === undefined) return at(UNREADABLE)
  if (!use.quoted || use.name === '*') return at(words.join(' '))
  if (wholeToken(script, use)) return { start: use.start - 1, end: use.end + 1, words: words.join(' ') }
  return at(words.length === 1 ? (words[0] ?? '') : UNREADABLE)
}
