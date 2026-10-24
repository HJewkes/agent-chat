/**
 * The variables a command's arithmetic re-evaluates (CC-1249). In `(( ))`, `$(( ))`, `$[ ]`, `let`, a
 * `declare -i` operand and an array subscript the shell evaluates a variable's value as arithmetic,
 * and some shells run a `$(...)` that value holds, so a substitution can arrive through a variable
 * the guard reads as a plain string. This lists the names; whether their values are safe is the
 * guard's question. It also finds a substitution written into the arithmetic itself, quoted.
 */
import { HOLE, LIVE, NAME, unmark, type SimpleCommand } from './shell-words.js'

const INTEGER_DECLARERS = new Set(['declare', 'typeset', 'local', 'integer'])
// A name the arithmetic expands, as `$i`, `${i}` or a bare `i`; an array's element value is evaluated too.
const ARITH_NAME = new RegExp(`\\$\\{?(${NAME})|(?<![A-Za-z0-9_#$])(${NAME})(?![A-Za-z0-9_])`, 'g')
// A literal `$(...)` or backtick in an operand or subscript is checked as a command already, so its words are not names.
const SUBSTITUTION = /\$\([^()]*\)|`[^`]*`/g
// `arr[...]=` and zsh's `$arr[...]` subscript a variable when the `[` is unquoted.
const LIVE_SUBSCRIPT = new RegExp(`(?:^|\\$)${NAME}${LIVE}\\[`, 'g')
const BRACED_SUBSCRIPT = new RegExp(`\\$\\{[#!]?${NAME}\\[`, 'g')

/** The text inside the `]` that closes each `[` at the given opening indexes, counting nested brackets. */
function bracketBodies(text: string, opens: number[]): string[] {
  return opens.map(open => {
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '[') depth++
      else if (text[i] === ']' && --depth === 0) return text.slice(open + 1, i)
    }
    return text.slice(open + 1)
  })
}

const openingsOf = (text: string, pattern: RegExp): number[] =>
  [...text.matchAll(pattern)].map(match => match.index + match[0].length - 1)

/** The subscript bodies of one marked word: `arr[...]=`, `$arr[...]` and `${arr[...]}`, quoted or not. */
function subscripts(marked: string): string[] {
  const live = bracketBodies(marked, openingsOf(marked, LIVE_SUBSCRIPT))
  const plain = marked.replaceAll(LIVE, '')
  return [
    ...live.map(body => body.replaceAll(LIVE, '')),
    ...bracketBodies(plain, openingsOf(plain, BRACED_SUBSCRIPT)),
  ]
}

const hasIntegerFlag = (words: string[]): boolean =>
  words[0] === 'integer' || words.some(word => /^-[A-Za-z]*i/.test(word))

/** The operands `let` evaluates, and the values a `declare -i`, `typeset -i`, `local -i` or `integer` assigns. */
function integerOperands(words: string[]): string[] {
  const [head = '', ...rest] = words
  if (head === 'let') return rest
  if (!INTEGER_DECLARERS.has(head) || !hasIntegerFlag(words)) return []
  return rest.filter(word => word.includes('=')).map(word => word.slice(word.indexOf('=') + 1))
}

/** Every name whose value `cmd` evaluates as arithmetic, each once, in the order first met. */
export function arithSubscriptNames(cmd: SimpleCommand): string[] {
  const texts = [...cmd.arithBodies, ...integerOperands(cmd.words), ...cmd.marked.flatMap(subscripts)]
  const names = texts.flatMap(text =>
    [...text.replace(SUBSTITUTION, ' ').matchAll(ARITH_NAME)].map(match => match[1] ?? match[2] ?? ''),
  )
  return [...new Set(names)]
}

// bash evaluates both operands of these as arithmetic in `[[ ]]`; `[ ]` and `test` are held to the same rule.
const ARITH_TESTS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
// A `$(...)`, backtick or funsub; an arithmetic body has each one the splitter read blanked, and `$'...'` is not decoded.
const BODY_SUBSTITUTION = /\$\(|`|\$\{[\s|]|\$'/
const OPENER = /\$\(|`|\$\{[\s|]/

// A `$(` left here is an escaped `\(`, since each substitution the splitter read is a HOLE by now.
const CLOSERS: Readonly<Record<string, string>> = { '{': '}', '[': ']' }
const PARAMETER = new RegExp(`^(?:${NAME}|[0-9@*#?$!-])`)

/** The index past the live expansion whose `$` is at `at`: `$x`, `$1`, `$@`, `${...}` or `$[...]`; undefined for a bare `$`. */
function expansionEnd(text: string, at: number): number | undefined {
  let i = at + 1
  while (text[i] === LIVE) i++
  const open = text[i] ?? ''
  const close = CLOSERS[open]
  if (close === undefined) {
    const name = PARAMETER.exec(text.slice(i))
    return name === null ? undefined : i + name[0].length
  }
  let depth = 0
  for (; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close && --depth === 0) return i + 1
  }
  return text.length
}

/**
 * `word` with each live expansion as a HOLE, since bash may expand any of them to nothing: the substitutions the
 * splitter read, so a quote inside one is not mistaken for the word's, then every parameter expansion left.
 */
function withHoles(word: string, cmd: SimpleCommand): string {
  const text = cmd.substitutions.reduce((holed, sub) => holed.replaceAll(`${LIVE}${sub.raw}`, HOLE), word)
  let out = ''
  for (let i = 0; i < text.length;) {
    const end = text.startsWith(`${LIVE}$`, i) ? expansionEnd(text, i + 1) : undefined
    out += end === undefined ? text[i] : HOLE
    i = end ?? i + 1
  }
  return out
}

const HOLES = new RegExp(`${HOLE}+`, 'g')
const joined = (text: string): string => text.replaceAll(HOLE, '')

/** The depth of `[ ]` nesting left open at the end of `text`. */
function openDepth(text: string): number {
  let depth = 0
  for (const c of text) {
    if (c === '[') depth++
    else if (c === ']' && depth > 0) depth--
  }
  return depth
}

/** Whether `text` holds a `]` that closes a `[` opened before it. */
function closesEarlier(text: string): boolean {
  let depth = 0
  for (const c of text) {
    if (c === '[') depth++
    else if (c === ']' && depth-- === 0) return true
  }
  return false
}

/**
 * Whether what a substitution prints could finish an opener with the text beside it, as `'a[$'"$(printf '(')"'cmd)]'`
 * does: one inside or before a `[ ]`, with a `$` or backtick before it or anything but its `]` after it.
 */
function holeMayFinishOpener(text: string): boolean {
  return [...text.matchAll(HOLES)].some(match => {
    const before = joined(text.slice(0, match.index))
    const after = joined(text.slice(match.index + match[0].length))
    const subscripted = openDepth(before) > 0 || closesEarlier(after)
    return subscripted && (/[$`]$/.test(before) || !/^(?:\]|$)/.test(after))
  })
}

/** The operands beside each arithmetic comparison, wherever a `[[ ]]` the splitter broke at `&&` or `(` left it. */
function comparisonOperands(marked: string[]): string[] {
  return marked.flatMap((word, i) =>
    ARITH_TESTS.has(unmark(word)) ? [marked[i - 1] ?? '', marked[i + 1] ?? ''] : [],
  )
}

// Line continuation and the arithmetic re-read drop a backslash, so `$\<newline>(` and `$\(` both become `$(`.
const asEvaluated = (text: string): string => text.replaceAll('\\\n', '').replaceAll('\\', '')

const OPENS_AT = /^(?:\$\(|`|\$\{[\s|])/

/** A substitution opener inside a `[ ]`, nesting counted; an unclosed `[` runs to the end of the text. */
function openerInBrackets(text: string): boolean {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') depth++
    else if (text[i] === ']' && depth > 0) depth--
    else if (depth > 0 && OPENS_AT.test(text.slice(i, i + 3))) return true
  }
  return false
}

/**
 * Whether arithmetic in `cmd` may run a substitution the splitter read as plain text (CC-1473). Evaluating
 * an array subscript runs a `$(...)` in it even from a quoted `'a[$(cmd)]'`, and a `(( ))` body runs one
 * with no subscript at all, so a command can hide there that the guard never checks.
 *
 * Which words the shell evaluates as subscripts turns on attributes set earlier, namerefs, builtins
 * that take a variable name and the array literal syntax, so any word of any command with an opener
 * inside a `[ ]` denies. `head` is the command past its wrappers, read for `let` and `declare -i`
 * operands; undefined where the wrappers cannot be read, which scans every word.
 */
export function hidesArithSubstitution(cmd: SimpleCommand, head: readonly string[] | undefined): boolean {
  if (cmd.arithBodies.some(body => BODY_SUBSTITUTION.test(asEvaluated(body)))) return true
  // Substitutions the splitter read are checked as commands; a live `$` before an escaped `\(` is `$(` unmarked.
  const holed = (word: string): string => asEvaluated(unmark(withHoles(word, cmd)))
  // bash joins the text around a substitution, so `$` and `"$(true)"` and `(` read as `$(`.
  const plain = (word: string): string => joined(holed(word))
  if (cmd.marked.map(holed).some(holeMayFinishOpener)) return true
  const words = cmd.marked.map(plain)
  if (words.some(openerInBrackets)) return true
  const operands = head === undefined ? words : integerOperands(head.map(plain))
  return [...operands, ...comparisonOperands(cmd.marked).map(plain)].some(text => OPENER.test(text))
}
