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

const PLAIN_NAME = new RegExp(`^${NAME}$`)

interface CommandHead {
  /** The words and marked words from the command word on, so `if read x` reads as `read x`. */
  words: string[]
  marked: string[]
  /** The `NAME=value` and `NAME[...]=value` assignment words before it, which bash resolves as names. */
  assignments: string[]
  markedAssignments: string[]
}

/** How many words a `coproc` at `at` puts before its command: itself, and a NAME when a compound command follows. */
const coprocWidth = (words: string[], at: number): number =>
  PLAIN_NAME.test(words[at + 1] ?? '') && KEYWORDS.has(words[at + 2] ?? '') ? 2 : 1

function commandHead(cmd: SimpleCommand): CommandHead {
  const { words, marked } = cmd
  const assigns: number[] = []
  let start = 0
  while (start < words.length) {
    const word = words[start] ?? ''
    const passOption = PASS_OPTIONS.has(word) && TRANSPARENT.has(words[start - 1] ?? '')
    if (ASSIGNMENT.test(word)) assigns.push(start)
    else if (word === 'coproc') start += coprocWidth(words, start) - 1
    else if (!TRANSPARENT.has(word) && !passOption) break
    start++
  }
  return {
    words: words.slice(start),
    marked: marked.slice(start),
    assignments: assigns.map(i => words[i] ?? ''),
    markedAssignments: assigns.map(i => marked[i] ?? ''),
  }
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
  return hasIntegerFlag(words) ? declaredValues(words, source, operands) : []
}

/** The values a `declare -n`, `typeset -n` or `local -n` assigns: names, whose subscripts are arithmetic. */
const namerefValues = (words: string[], source: string[], operands: number[]): string[] =>
  words.some(word => /^-[A-Za-z]*n/.test(word)) ? declaredValues(words, source, operands) : []

/** The value part of each declarer operand in `source` that has one. */
function declaredValues(words: string[], source: string[], operands: number[]): string[] {
  if (!DECLARERS.has(words[0] ?? '')) return []
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

// printf's `-vNAME`, the name attached to its option.
const ATTACHED_NAME = /^-v(.+)$/s

/** The name part of every word `source` holds that bash resolves as a variable name: prefix assignments, operands, `-vNAME`. */
function nameTexts(words: string[], source: string[], assignments: string[]): string[] {
  const attached = words[0] === 'printf' ? source.flatMap(word => ATTACHED_NAME.exec(word)?.[1] ?? []) : []
  return [...assignments, ...nameOperands(words).map(i => source[i] ?? ''), ...attached].map(namePart)
}

// The `x=(` or `x+=(` that opens a compound array: the splitter ends the opener's last word there, with a
// LIVE mark for the `(`, and reads the elements as nested commands after it.
const OPENER = new RegExp(`^${NAME}\\+?=${LIVE}$`)
const LIST_JOINS = new Set(['', '\n'])
// One `[key]=value` or `[key]+=value` element; the key runs to the last `]=`, so nothing is lost from both.
const ELEMENT = new RegExp(`^${LIVE}\\[(.*)\\]\\+?=(.*)$`, 's')
const KEY_CLOSE = /\]\+?=/

interface Element {
  key?: string
  value: string
}

/**
 * The marked words of the compound array list `cmd` opens, read from the commands after it in `line`
 * and skipping the commands of the substitutions inside it; undefined when `cmd` opens none.
 */
/**
 * The command list that holds `cmd` innermost: a substitution's own commands for a `cmd` inside one, which
 * the splitter also lists, flattened, in `line` and in every enclosing substitution; else `line` itself.
 */
function containingList(cmd: SimpleCommand, line: readonly SimpleCommand[]): readonly SimpleCommand[] {
  const lists = [line, ...line.flatMap(c => c.substitutions.map(sub => sub.commands))]
  return lists
    .filter(list => list.includes(cmd))
    .reduce((best, list) => (list.length < best.length ? list : best), line)
}

function compoundList(cmd: SimpleCommand, parsed: readonly SimpleCommand[]): string[] | undefined {
  if (!OPENER.test(cmd.marked.at(-1) ?? '')) return undefined
  const line = containingList(cmd, parsed)
  const inner = new Set(line.flatMap(c => c.substitutions.flatMap(sub => sub.commands)))
  const words: string[] = []
  for (const next of line.slice(line.indexOf(cmd) + 1)) {
    if (inner.has(next)) continue
    if (!next.nested || !LIST_JOINS.has(next.before)) break
    words.push(...next.marked)
    if (!LIST_JOINS.has(next.after)) break
  }
  return words
}

/** The elements of a compound list, joining a key that spans words (`[ k ]=v`); a key that never closes runs to the end. */
function elements(words: string[]): Element[] {
  const found: Element[] = []
  for (let i = 0; i < words.length; i++) {
    let word = words[i] ?? ''
    if (!word.startsWith(`${LIVE}[`)) {
      found.push({ value: word })
      continue
    }
    while (!KEY_CLOSE.test(word) && i + 1 < words.length) word += ` ${words[++i]}`
    const match = ELEMENT.exec(word)
    found.push(match ? { key: match[1] ?? '', value: match[2] ?? '' } : { key: word.slice(2), value: '' })
  }
  return found
}

/**
 * The marked texts bash evaluates in the compound list `cmd` opens: every key, as a subscript, and every
 * value too when the declarer gives the array the integer attribute.
 */
function compoundTexts(cmd: SimpleCommand, line: readonly SimpleCommand[]): string[] {
  const list = compoundList(cmd, line)
  if (list === undefined) return []
  const { words } = commandHead(cmd)
  const integer = DECLARERS.has(words[0] ?? '') && hasIntegerFlag(words)
  return elements(list).flatMap(({ key, value }) => [
    ...(key === undefined ? [] : [key]),
    ...(integer ? [value] : []),
  ])
}

/** A variable name's own `$` expansions, whose values become the name, and the names its subscript reads. */
function nameOperandNames(word: string): string[] {
  const open = word.indexOf('[')
  const subscript = open < 0 ? [] : bracketBodies(word, [open])
  return [...[...word.matchAll(DOLLAR_NAME)].map(match => match[1] ?? ''), ...subscript.flatMap(namesIn)]
}

const namesIn = (text: string): string[] =>
  [...text.replace(SUBSTITUTION, ' ').matchAll(ARITH_NAME)].map(match => match[1] ?? match[2] ?? '')

/**
 * Every name whose value `cmd` evaluates as arithmetic, each once, in the order first met. `line` is the
 * parsed command line `cmd` came from; a compound array's elements are read from the commands after it.
 */
export function arithSubscriptNames(cmd: SimpleCommand, line: readonly SimpleCommand[]): string[] {
  const { words, assignments } = commandHead(cmd)
  const operands = nameOperands(words)
  const texts = [
    ...cmd.arithBodies,
    ...integerValues(words, words, operands),
    ...cmd.marked.flatMap(subscripts),
    ...comparisonOperands(words).map(i => words[i] ?? ''),
    ...compoundTexts(cmd, line).map(unmark),
  ]
  const nameWords = [...nameTexts(words, words, assignments), ...namerefValues(words, words, operands)]
  const names = [...texts.flatMap(namesIn), ...nameWords.flatMap(nameOperandNames)]
  return [...new Set(names)]
}

/** Where the `$(...)` whose body starts at `from` closes, past quotes and nested parentheses; the end when it never does. */
function bodyEnd(text: string, from: number, open = '(', close = ')'): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') i++
    else if (c === "'" || c === '"') i = quoteEnd(text, i)
    else if (c === open) depth++
    else if (c === close && depth-- === 0) return i
  }
  return text.length
}

// bash 5.3's `${ list; }` and `${| list; }`. The splitter cuts their words at the first `}`, even a quoted one, so
// their text cannot be read here; until a real funsub reader lands (CC-1327 a) the rest of the command is
// reported whole as one text, unread, the same fail-closed signal as a compound key that never closes.
const FUNSUB = new RegExp(`${LIVE}\\$\\{[\\s|]`)

/** The command's text from its first live funsub on, unmarked, or nothing when it holds none. */
function funsubRest(marked: readonly string[]): string[] {
  const at = marked.findIndex(word => FUNSUB.test(word))
  if (at < 0) return []
  const first = marked[at] ?? ''
  return [unmark([first.slice(first.search(FUNSUB)), ...marked.slice(at + 1)].join(' '))]
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

/** The quoted substitutions one command of `parsed` runs as arithmetic or as a name. */
function substitutionsOf(cmd: SimpleCommand, parsed: readonly SimpleCommand[]): string[] {
  const { marked, words, markedAssignments } = commandHead(cmd)
  const operands = nameOperands(words)
  const texts = [
    ...comparisonOperands(words).map(i => marked[i] ?? ''),
    ...nameTexts(words, marked, markedAssignments),
    ...integerValues(words, marked, operands),
    ...namerefValues(words, marked, operands),
    ...compoundTexts(cmd, parsed),
  ]
  // A live substitution in an arithmetic body is blanked already, so every one left was quoted.
  return [...texts, ...cmd.arithBodies].flatMap(quotedSubstitutions)
}

/**
 * The text of each quoted `$(...)` or backtick the shell runs when it evaluates an operand as arithmetic
 * or resolves it as a variable name (CC-1334), which the splitter never read as a command, across every
 * command of `parsed`, the whole output of `parseShell`. A live substitution is a command already, so it
 * is not listed. It takes the whole line so a compound array's elements, which follow its opener in the
 * list that holds it, cannot be missed by passing the wrong commands. A funsub is reported whole, from its `${` on.
 */
export function arithSubstitutions(parsed: readonly SimpleCommand[]): string[] {
  const bodies = parsed.flatMap(cmd => [...substitutionsOf(cmd, parsed), ...funsubRest(cmd.marked)])
  return [...new Set(bodies)]
}
