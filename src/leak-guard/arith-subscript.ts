/**
 * The variables a command's arithmetic re-evaluates (CC-1249). In `(( ))`, `$(( ))`, `$[ ]`, `let`, a
 * `declare -i` operand and an array subscript the shell evaluates a variable's value as arithmetic,
 * and some shells run a `$(...)` that value holds, so a substitution can arrive through a variable
 * the guard reads as a plain string. This lists the names; whether their values are safe is the
 * guard's question.
 */
import { LIVE, NAME, type SimpleCommand, unmark } from './shell-words.js'

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

/**
 * Builtins whose operands are all variable names or may be read as such (`getopts` optstring and args,
 * `read -p` prompt). Shared with the pretool guard, which fails closed on an expansion in any of them,
 * so the two readers of a variable-name operand cannot drift (CC-1334).
 */
export const NAME_OPERAND_BUILTINS: ReadonlySet<string> = new Set([
  'read',
  'getopts',
  'mapfile',
  'readarray',
  'unset',
])
/** Builtins whose operands are `NAME` or `NAME=value` assignments. Shared with the pretool guard. */
export const ENV_DECL: ReadonlySet<string> = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])
const DECLARERS = new Set([...ENV_DECL, 'integer'])
// Options that take the next word as their argument, which is not a name.
const ARG_OPTIONS: Readonly<Record<string, RegExp>> = {
  read: /^-[ersE]*[adinNptu]$/,
  mapfile: /^-t*[dnOsuCc]$/,
  readarray: /^-t*[dnOsuCc]$/,
}

const hasIntegerFlag = (words: string[]): boolean =>
  words[0] === 'integer' || words.some(word => /^-[A-Za-z]*i/.test(word))

/** Where the assignment `=` (or `+=`) of a `NAME[...]=value` word is, past its subscript; the end when there is none. */
function nameEnd(word: string): number {
  let depth = 0
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '[') depth++
    else if (word[i] === ']') depth--
    else if (word[i] === '=' && depth <= 0) return word[i - 1] === '+' ? i - 1 : i
  }
  return word.length
}

const namePart = (word: string): string => word.slice(0, nameEnd(word))

/**
 * The values a `declare -i`, `typeset -i`, `local -i` or `integer` assigns, and every `let` operand, taken
 * from `source`: the words themselves or their marked form.
 */
function integerValues(words: string[], source: string[], operands: number[]): string[] {
  if (words[0] === 'let') return source.slice(1)
  if (!DECLARERS.has(words[0] ?? '') || !hasIntegerFlag(words)) return []
  return operands.flatMap(i => {
    const word = source[i] ?? ''
    const at = word.indexOf('=', nameEnd(word))
    return at < 0 ? [] : [word.slice(at + 1)]
  })
}

// `[[ ]]` evaluates both sides of these as arithmetic; bash's `test` and `[` want an integer instead (CC-1334).
const ARITH_COMPARISONS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
const TEST_HEADS = new Set(['test', '['])
const DOLLAR_NAME = new RegExp(`\\$\\{?(${NAME})`, 'g')

/** Indexes of the words around each arithmetic comparison; `&&`, `||` and `(` split a `[[ ]]`, so any head but test or `[`. */
function comparisonOperands(words: string[]): number[] {
  if (TEST_HEADS.has(words[0] ?? '')) return []
  return words
    .flatMap((word, i) => (ARITH_COMPARISONS.has(word) ? [i - 1, i + 1] : []))
    .filter(i => i >= 0 && i < words.length)
}

const inConditional = (words: string[]): boolean =>
  TEST_HEADS.has(words[0] ?? '') || words[0] === '-v' || words.includes('[[') || words.at(-1) === ']]'

/**
 * Indexes of the words the shell resolves as variable names, whose subscripts it evaluates as arithmetic:
 * the operands of a name-operand builtin or declarer, and the name after a `-v` test or `printf -v`.
 */
function nameOperands(words: string[]): number[] {
  const head = words[0] ?? ''
  if (NAME_OPERAND_BUILTINS.has(head) || DECLARERS.has(head)) return operandIndexes(words, ARG_OPTIONS[head])
  if (head !== 'printf' && !inConditional(words)) return []
  return words.flatMap((word, i) => (word === '-v' && i + 1 < words.length ? [i + 1] : []))
}

/** The indexes of the operands after the head, past options and the arguments `argOption` says they take. */
function operandIndexes(words: string[], argOption: RegExp | undefined): number[] {
  const operands: number[] = []
  let options = true
  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? ''
    if (options && word === '--') options = false
    else if (options && argOption?.test(word)) i++
    else if (!options || !/^[-+]./.test(word)) operands.push(i)
  }
  return operands
}

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
  const operands = nameOperands(words)
  const texts = [
    ...cmd.arithBodies,
    ...integerValues(words, words, operands),
    ...cmd.marked.flatMap(subscripts),
    ...comparisonOperands(words).map(i => words[i] ?? ''),
  ]
  const names = [
    ...texts.flatMap(namesIn),
    ...operands.flatMap(i => nameOperandNames(namePart(words[i] ?? ''))),
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

/**
 * The text of each quoted `$(...)` or backtick the shell runs when it evaluates an operand as arithmetic
 * or resolves it as a variable name (CC-1334), which the splitter never read as a command. A live
 * substitution is a command already, so it is not listed.
 */
export function arithSubstitutions(cmd: SimpleCommand): string[] {
  const { marked, words } = commandHead(cmd)
  const names = nameOperands(words)
  const texts = [
    ...comparisonOperands(words).map(i => marked[i] ?? ''),
    ...names.map(i => namePart(marked[i] ?? '')),
    ...integerValues(words, marked, names),
  ]
  // A live substitution in an arithmetic body is blanked already, so every one left was quoted.
  const fromBodies = cmd.arithBodies.flatMap(quotedSubstitutions)
  const bodies = texts.flatMap(quotedSubstitutions)
  return [...new Set([...bodies, ...fromBodies])]
}
