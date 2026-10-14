/**
 * The variables a command's arithmetic re-evaluates (CC-1249). In `(( ))`, `$(( ))`, `$[ ]`, `let`, a
 * `declare -i` operand and an array subscript the shell evaluates a variable's value as arithmetic,
 * and some shells run a `$(...)` that value holds, so a substitution can arrive through a variable
 * the guard reads as a plain string. This lists the names; whether their values are safe is the
 * guard's question.
 *
 * `arithSubstitutions` lists the body of every quoted substitution on a line, unconditionally (CC-1334).
 * Text reaches a variable that may carry the integer attribute, set even before the line, through any word
 * or stdin, and the name or its `[` can itself be produced at runtime, so no reading of the text can tell
 * which quoted `$(...)` bash will evaluate. The guard checks each body as a command. Two limits:
 * - Over-reporting is the intended fail-closed choice: a commit or PR body that quotes a denied command
 *   inside `$(...)` is reported too, and the guard decides.
 * - Data read at runtime from a file (`read n < file`, `$(<file)`) is out of reach, and so is a `$` produced
 *   at runtime (`x[$d'(P)]'`, `printf 'x[\\x24(P)]'`).
 */
import { LIVE, NAME, parseShell, type SimpleCommand, unmark } from './shell-words.js'

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
 * The command list that holds `cmd` innermost: a substitution's own commands for a `cmd` inside one, which
 * the splitter also lists, flattened, in `line` and in every enclosing substitution; else `line` itself.
 */
function containingList(cmd: SimpleCommand, line: readonly SimpleCommand[]): readonly SimpleCommand[] {
  const lists = [line, ...line.flatMap(c => c.substitutions.map(sub => sub.commands))]
  return lists
    .filter(list => list.includes(cmd))
    .reduce((best, list) => (list.length < best.length ? list : best), line)
}

/**
 * The marked words of the compound array list `cmd` opens, read from the commands after it in `line`
 * and skipping the commands of the substitutions inside it; undefined when `cmd` opens none.
 */
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

// bash 5.3's `${ list; }` and `${| list; }`. This module does not read a funsub's text: the rest of the command
// from its `${` is reported whole as one raw text that starts with `${`, a live `${ date; }` included. That is
// not a command: the guard (slice b) must deny any body that starts with `${` rather than check it as one.
const FUNSUB = new RegExp(`${LIVE}\\$\\{[\\s|]`)

/** The command's text from its first live funsub on, unmarked, or nothing when it holds none. */
function funsubRest(marked: readonly string[]): string[] {
  const at = marked.findIndex(word => FUNSUB.test(word))
  if (at < 0) return []
  const first = marked[at] ?? ''
  return [unmark([first.slice(first.search(FUNSUB)), ...marked.slice(at + 1)].join(' '))]
}

// A funsub `${ ` (space, tab or newline after `${`) or valsub `${|`: bash runs it, the splitter cuts it at
// its first `}`, so its text cannot be read and the rest from the `${` is reported as a `${` sentinel.
const funsubAt = (text: string, i: number): boolean =>
  text.startsWith('${', i) && /[\s|]/.test(text[i + 2] ?? '')

// Past these, a text is not read at all: the rest from its first opener is the fail-closed sentinel. With the
// parse window and the deadline they keep the read well inside the guard's deadline, which allows on timeout
// (failopen.ts), so padding cannot buy a pass. parseShell is superlinear on some data (unbalanced `(`, globs)
// and can throw, so each call reads at most the last of PARSE_WINDOWS characters and a throw is a sentinel.
const MAX_TEXT = 1 << 20
const MAX_OPENERS = 20_000
const PARSE_WINDOWS = [256, 1024, 4096]
const DEADLINE_MS = 1000
const SUBSTITUTION_OPENER = /\$\(|`/g

// A raw the lexer closed: `$(...)` ends with `)`, a backtick pair with a backtick.
const closed = (raw: string): boolean => raw.endsWith(')') || (raw.length > 1 && raw.endsWith('`'))

/**
 * Where each outermost `$(`, `$((` or backtick substitution the lexer closes in the window of `plain` from
 * `from` starts, with its exact raw text, from one `parseShell` of that window, or undefined when it throws.
 * The lexer the guard trusts ends each one, so a `case`, `#` comment or heredoc inside is not cut short. The
 * window starts at an opener, so quote characters in the data before it are not read as quotes; a raw the
 * window cut off is left out, so its opener is read again from its own window. Raws come in source order,
 * so each is found from the end of the one before.
 */
function windowStarts(plain: string, from: number, size: number): Map<number, string> | undefined {
  const window = plain.slice(from, from + size)
  let parsed: SimpleCommand[]
  try {
    parsed = parseShell(window)
  } catch {
    return undefined
  }
  const inner = new Set(parsed.flatMap(cmd => cmd.substitutions.flatMap(sub => sub.commands)))
  const starts = new Map<number, string>()
  let cursor = 0
  for (const { raw } of parsed.filter(cmd => !inner.has(cmd)).flatMap(cmd => cmd.substitutions)) {
    const at = window.indexOf(raw, cursor)
    if (at < 0) continue
    if (closed(raw)) starts.set(from + at, raw)
    cursor = at + raw.length
  }
  return starts
}

/** The starts read from the smallest window that closes the opener at `from`, so a short sub costs a short parse. */
function substitutionStarts(plain: string, from: number): Map<number, string> | undefined {
  let starts: Map<number, string> | undefined
  for (const size of PARSE_WINDOWS) {
    starts = windowStarts(plain, from, size)
    if (starts === undefined || starts.has(from) || from + size >= plain.length) return starts
  }
  return starts
}

// The command inside an opener's raw: `$(cmd)`/`$((cmd))` to the text past `$(`, `` `cmd` `` to the text past the tick.
const openerBody = (raw: string): string => (raw[0] === '`' ? raw.slice(1, -1) : raw.slice(2, -1))

/**
 * The recorded substitution whose exact text starts `plain` at `i`, spending one count of it, or undefined.
 * Text from an opener on ends where the lexer ends it whatever comes before, so a match is the same raw
 * without a parse; spent once, a fake sharing a real sub's text is not trusted twice.
 */
function trusted(plain: string, i: number, counts: Map<string, number>): string | undefined {
  let best: string | undefined
  for (const [raw, n] of counts)
    if (n > 0 && plain.startsWith(raw, i) && raw.length > (best?.length ?? 0)) best = raw
  if (best !== undefined) counts.set(best, (counts.get(best) ?? 1) - 1)
  return best
}

/** What one quoted read needs beside its text: the recorded subs it may trust, and when the line's read must end. */
interface Read {
  counts: Map<string, number>
  deadline: number
}

/**
 * The body of every `$(`, `$((`, backtick or `${ ` opener bash recognizes in `text` that the splitter did
 * not itself read as a command. Each opener's extent comes from `parseShell`, never from counting parens.
 * Trust is per recorded substitution, spent once, because the splitter marks the literal `$` of `"$"` LIVE
 * too (so `x["$"'(P)]'` looks live though bash builds `$(P)`). An opener the lexer does not close in its
 * window, a throw, the deadline and a funsub all report the rest from the opener as a sentinel (it still
 * starts with `$(`, `` ` `` or `${`) that slice b denies without parsing.
 */
function quotedSubstitutions(text: string, read: Read): string[] {
  const plain = unmark(text)
  const first = plain.search(/\$\(|`|\$\{[\s|]/)
  if (first < 0) return []
  if (plain.length > MAX_TEXT || (plain.match(SUBSTITUTION_OPENER)?.length ?? 0) > MAX_OPENERS)
    return [plain.slice(first)]
  let starts: Map<number, string> | undefined = new Map()
  const bodies: string[] = []
  for (let i = first; i < plain.length; i++) {
    if (funsubAt(plain, i)) return [...bodies, plain.slice(i)]
    if (!plain.startsWith('$(', i) && plain[i] !== '`') continue
    const known = trusted(plain, i, read.counts)
    if (known === undefined && !starts.has(i)) {
      starts = performance.now() > read.deadline ? undefined : substitutionStarts(plain, i)
      if (starts === undefined) return [...bodies, plain.slice(i)]
    }
    const raw = known ?? starts.get(i)
    if (raw === undefined) return [...bodies, plain.slice(i)]
    if (known === undefined) bodies.push(openerBody(raw))
    i += raw.length - 1
  }
  return bodies
}

/** Every quoted substitution body in one command: in each word, its here-string or heredoc, and its arithmetic. */
function substitutionsOf(cmd: SimpleCommand, deadline: number): string[] {
  const counts = new Map<string, number>()
  for (const sub of cmd.substitutions) counts.set(sub.raw, (counts.get(sub.raw) ?? 0) + 1)
  // A live substitution in an arithmetic body is blanked already, so every one left was quoted.
  const texts = [...cmd.marked, ...(cmd.stdin === undefined ? [] : [cmd.stdin]), ...cmd.arithBodies]
  return texts.flatMap(text => quotedSubstitutions(text, { counts, deadline }))
}

/**
 * The body of every quoted `$(...)` and backtick in every word, here-string and heredoc of every command
 * of `parsed`, the whole output of `parseShell` (CC-1334), whatever the command: the splitter never read
 * them as commands, and arithmetic can run them (see the module header). A live substitution is a command
 * already, so it is not listed. A funsub is reported whole, from its `${` on.
 */
export function arithSubstitutions(parsed: readonly SimpleCommand[]): string[] {
  const deadline = performance.now() + DEADLINE_MS
  const bodies = parsed.flatMap(cmd => [...substitutionsOf(cmd, deadline), ...funsubRest(cmd.marked)])
  return [...new Set(bodies)]
}
