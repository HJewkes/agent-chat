/**
 * The variables a command's arithmetic re-evaluates (CC-1249). In `(( ))`, `$(( ))`, `$[ ]`, `let`, a
 * `declare -i` operand and an array subscript the shell evaluates a variable's value as arithmetic,
 * and some shells run a `$(...)` that value holds, so a substitution can arrive through a variable
 * the guard reads as a plain string. This lists the names; whether their values are safe is the
 * guard's question.
 */
import { LIVE, NAME, type SimpleCommand, unmark } from './shell-words.js'

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

// Words before the command word: keywords the splitter keeps in `words` (as shell-words' COMMAND_PREFIX),
// and `command`/`builtin`, which run the builtin they name.
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time'])
const TRANSPARENT = new Set([...KEYWORDS, 'command', 'builtin'])
const PASS_OPTIONS = new Set(['-p', '--'])
const ASSIGNMENT = new RegExp(`^${NAME}(\\[.*\\])?\\+?=`)

/** The command's words and marked words from its command word on, so `if read x` reads as `read x`. */
function commandHead(cmd: SimpleCommand): { words: string[]; marked: string[] } {
  let start = 0
  while (start < cmd.words.length) {
    const word = cmd.words[start] ?? ''
    const passOption = PASS_OPTIONS.has(word) && TRANSPARENT.has(cmd.words[start - 1] ?? '')
    if (!TRANSPARENT.has(word) && !ASSIGNMENT.test(word) && !passOption) break
    start++
  }
  return { words: cmd.words.slice(start), marked: cmd.marked.slice(start) }
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

// `[[ ]]` evaluates both sides of these as arithmetic; bash's `test` and `[` want an integer instead (CC-1334).
const ARITH_COMPARISONS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
const TEST_HEADS = new Set(['test', '['])
// bash `read` options that take the next word as their argument.
const READ_ARG_OPTIONS = /^-[ersE]*[adinNptu]$/
const DOLLAR_NAME = new RegExp(`\\$\\{?(${NAME})`, 'g')

/** Indexes of the words around each arithmetic comparison; `&&`, `||` and `(` split a `[[ ]]`, so any head but test or `[`. */
function comparisonOperands(words: string[]): number[] {
  if (TEST_HEADS.has(words[0] ?? '')) return []
  return words.flatMap((word, i) => (ARITH_COMPARISONS.has(word) ? [i - 1, i + 1] : []))
}

const inConditional = (words: string[]): boolean =>
  TEST_HEADS.has(words[0] ?? '') || words[0] === '-v' || words.includes('[[') || words.at(-1) === ']]'

/** Indexes of the variable names a `-v` test, `printf -v` or `read` resolves, whose subscripts are arithmetic. */
function nameOperands(words: string[]): number[] {
  if (words[0] === 'read') return readNames(words)
  if (words[0] !== 'printf' && !inConditional(words)) return []
  return words.flatMap((word, i) => (word === '-v' ? [i + 1] : []))
}

function readNames(words: string[]): number[] {
  const names: number[] = []
  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? ''
    if (READ_ARG_OPTIONS.test(word)) i++
    else if (!word.startsWith('-')) names.push(i)
  }
  return names
}

const inRange = (words: string[]) => (i: number) => i >= 0 && i < words.length

/** A variable name's own `$` expansions, whose values become the name, and the names its subscript reads. */
function nameOperandNames(word: string): string[] {
  const open = word.indexOf('[')
  const subscript = open < 0 ? [] : bracketBodies(word, [open])
  return [...[...word.matchAll(DOLLAR_NAME)].map(match => match[1] ?? ''), ...subscript.flatMap(namesIn)]
}

const namesIn = (text: string): string[] =>
  [...text.replace(SUBSTITUTION, ' ').matchAll(ARITH_NAME)].map(match => match[1] ?? match[2] ?? '')

/** Every name whose value `cmd` evaluates as arithmetic, each once, in the order first met. */
export function arithSubscriptNames(cmd: SimpleCommand): string[] {
  const { words } = commandHead(cmd)
  const texts = [
    ...cmd.arithBodies,
    ...integerOperands(words),
    ...cmd.marked.flatMap(subscripts),
    ...comparisonOperands(words)
      .filter(inRange(words))
      .map(i => words[i] ?? ''),
  ]
  const names = [
    ...texts.flatMap(namesIn),
    ...nameOperands(words)
      .filter(inRange(words))
      .flatMap(i => nameOperandNames(words[i] ?? '')),
  ]
  return [...new Set(names)]
}

/** Where the `$(...)` whose body starts at `from` closes, past quotes and nested parentheses; the end when it never does. */
function bodyEnd(text: string, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') i++
    else if (c === "'" || c === '"') i = quoteEnd(text, i)
    else if (c === '(') depth++
    else if (c === ')' && depth-- === 0) return i
  }
  return text.length
}

function quoteEnd(text: string, open: number): number {
  const quote = text[open]
  for (let i = open + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') i++
    else if (text[i] === quote) return i
  }
  return text.length
}

/** The body of each `$(...)` and backtick pair in `marked` that is not LIVE: text the splitter kept quoted. */
function quotedSubstitutions(marked: string): string[] {
  const bodies: string[] = []
  for (let i = 0; i < marked.length; i++) {
    const live = marked[i - 1] === LIVE
    if (marked.startsWith('$(', i) && marked[i + 2] !== '(') {
      const end = bodyEnd(marked, i + 2)
      if (!live) bodies.push(marked.slice(i + 2, end))
      i = end
    } else if (marked[i] === '`') {
      const close = marked.indexOf('`', i + 1)
      const end = close < 0 ? marked.length : close
      if (!live) bodies.push(marked.slice(i + 1, end))
      i = end
    }
  }
  return bodies.map(unmark)
}

/** The marked `let` operands and `declare -i` assignments, name and value, the shell evaluates as arithmetic. */
function integerWords(words: string[], marked: string[]): string[] {
  const rest = marked.slice(1)
  if (words[0] === 'let') return rest
  if (!INTEGER_DECLARERS.has(words[0] ?? '') || !hasIntegerFlag(words)) return []
  return rest.filter(word => word.includes('='))
}

/**
 * The text of each quoted `$(...)` or backtick the shell runs when it evaluates an operand as arithmetic
 * or resolves it as a variable name (CC-1334), which the splitter never read as a command. A live
 * substitution is a command already, so it is not listed.
 */
export function arithSubstitutions(cmd: SimpleCommand): string[] {
  const { marked, words } = commandHead(cmd)
  const operands = [...comparisonOperands(words), ...nameOperands(words)]
    .filter(inRange(words))
    .map(i => marked[i] ?? '')
  // A live substitution in an arithmetic body is blanked already, so every one left was quoted.
  const fromBodies = cmd.arithBodies.flatMap(quotedSubstitutions)
  const bodies = [...operands, ...integerWords(words, marked)].flatMap(quotedSubstitutions)
  return [...new Set([...bodies, ...fromBodies])]
}
