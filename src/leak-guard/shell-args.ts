/**
 * Fills the positionals a `sh -c SCRIPT [ARG0 [ARGS...]]` script reads with the words the shell
 * binds to them (CC-1201), so the guard can check the script as the command line it becomes.
 * A word the guard cannot read becomes `$@`, which the guard already reads as "unreadable, may be
 * none or several", in the same quote context as the positional it replaces.
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

/** The filled script, or the word through which the script reads its arguments in a way a fill cannot follow. */
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
const BARE = /^\$([0-9@*])/
// Restated from git-alias.ts, which does not export it; the empty word is plain too.
const FILL_PLAIN = /^[A-Za-z0-9_./:=@%+-]*$/
const UNREADABLE = '$@'
const BOUNDARY = /[\s;&|()<>]/

const BEFORE = String.raw`(?:^|[\s;&|(){}])`
const AFTER = String.raw`(?=$|[\s;&|()])`
const IMPLICIT_READERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['shift', new RegExp(`${BEFORE}shift${AFTER}`)],
  ['getopts', new RegExp(`${BEFORE}getopts${AFTER}`)],
  ['for', new RegExp(`${BEFORE}for\\s+[A-Za-z_]\\w*\\s*(?:;|\\n|do${AFTER})`)],
  ['function', new RegExp(`${BEFORE}(?:function\\s+[A-Za-z_]|[A-Za-z_][\\w-]*\\s*\\(\\s*\\))`)],
]
const SET_CALL = new RegExp(`${BEFORE}set((?:[ \\t]+[^\\s;&|()]+)*)`, 'g')

/** The script with each positional it reads replaced by its word, or the implicit reader that defeats a fill. */
export function fillScriptArgs(script: string, args: ScriptArgs): ScriptFill {
  if (args.params.length > 0 || args.more) {
    const implicit = implicitReader(script)
    if (implicit !== undefined) return { implicit }
  }
  let text = script
  for (const use of positionalUses(script).reverse()) {
    const { start, end, words } = replacement(script, use, args)
    text = text.slice(0, start) + words + text.slice(end)
  }
  return { text }
}

/** `shift`, `getopts`, `set` with operands, `for NAME` without `in`, or a function definition. */
function implicitReader(script: string): string | undefined {
  const found = IMPLICIT_READERS.find(([, pattern]) => pattern.test(script))
  if (found !== undefined) return found[0]
  return [...script.matchAll(SET_CALL)].some(call => setsParams(call[1] ?? '')) ? 'set' : undefined
}

/** Whether `set`'s words include an operand: `--` or a word that is not an option or `-o`'s value. */
function setsParams(rest: string): boolean {
  const words = rest
    .trim()
    .split(/[ \t]+/)
    .filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--' || !/^[-+]/.test(word)) return true
    if (/^[-+][A-Za-z]*o$/.test(word)) i++
  }
  return false
}

/** Every positional the script reads, outside single quotes and `$'...'` strings, with its span. */
function positionalUses(script: string): Use[] {
  const uses: Use[] = []
  let quote: string | undefined
  for (let i = 0; i < script.length; i++) {
    const c = script[i]
    if (quote === "'") quote = c === "'" ? undefined : quote
    else if (c === '\\' || script.startsWith('$$', i)) i++
    else if (quote === undefined && script.startsWith("$'", i)) i = ansiEnd(script, i + 2)
    else if (c === '"') quote = quote === '"' ? undefined : '"'
    else if (c === "'" && quote === undefined) quote = "'"
    else if (c === '$') {
      const use = useAt(script, i, quote === '"')
      if (use !== undefined) uses.push(use)
    }
  }
  return uses
}

function useAt(script: string, start: number, quoted: boolean): Use | undefined {
  const rest = script.slice(start)
  const braced = BRACED.exec(rest)
  if (braced !== null) {
    const end = start + braced[0].length
    return { start, end, name: braced[1] ?? '', quoted, modified: !EXACT.test(rest) }
  }
  const bare = BARE.exec(rest)
  return bare === null ? undefined : { start, end: start + 2, name: bare[1] ?? '', quoted, modified: false }
}

/** The index of the `'` that closes a `$'...'` string opened before `from`. */
function ansiEnd(script: string, from: number): number {
  for (let j = from; j < script.length; j++) {
    if (script[j] === '\\') j++
    else if (script[j] === "'") return j
  }
  return script.length
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
