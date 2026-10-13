/**
 * Whether a marked word holding a `${...}` may expand to an option word such as `--no-verify`
 * (CC-1286). bash splits `main${X:- --no-verify}` into two words, and zsh does the same for
 * `${=X:- …}`, so the unexpanded text of the word never looks like an option. The word is judged
 * as the words it may become: any expansion may be empty or end in a blank, so the text after it
 * may start a word of its own. Only `${...}` tails read in full count as safe; any other tail is
 * taken to inject text.
 */
import { LIVE, NAME } from './shell-words.js'

const DEFAULT_IFS = ' \t\n'
// zsh flags, a name, a positional or a special parameter, and an optional subscript. `!` is left out, so
// bash indirection such as ${!X:- -x} is never read and always denies.
const HEAD = new RegExp(`^[=~^]*(?:${NAME}|\\d+|[@*#?$-])(?:\\[[^\\]]*\\])?`)
// A special parameter must not run into a name (zsh reads `$#X` and `$+X` as one expansion), and a
// name must not take a zsh subscript or modifier; such a `$` is read as an unknown expansion.
const BARE_PARAMETER = new RegExp(`^\\$(?:${NAME}|\\d|[@*#?$!-](?![\\w{]))(?![\\[]|:[A-Za-z&])`)
const LENGTH = new RegExp(`^#(?:${NAME}|\\d+)$`)
const OFFSET = /^:\s*-?\d+(?::\s*-?\d+)?$/
// zsh modifiers that only reshape the value; `:s`, `:gs`, `:&` and `:g&` add text of their own.
const PLAIN_MODIFIERS = /^(?::[htreluqQaAP]\d*)+$/
const TRIM_OPERATOR = /^(?:##?|%%?)/
const VALUE_OPERATOR = /^(?:::=|:[-=+?]|[-=+?])/
const REPLACE_OPERATOR = /^(?::\/|\/[/#%]?)/
// Text with no expansion, quote or escape in it; a pattern may also hold glob characters.
const LITERAL = /^[\w\s.,/@%+=:{}-]*$/
const PATTERN = /^[\w\s.,@%+=:{}*?[\]!^~-]*$/
// A brace expansion such as `{a,-f}` or `{0..-1}` may start a word with any `-` it holds.
const BRACE_WITH_DASH = /[{}].*-|-.*[{}]/
// An option that takes its value after `=` keeps its literal name whatever the value expands to.
const OPTION_WITH_VALUE = /^--?[A-Za-z][\w-]*=/
// A word that starts with `-`, or with a glob that may match a file named `-x`.
const WORD_START = new RegExp(`^(?:-|${LIVE}[*?[])`)
// After an expansion whose end is unknown, any `-` or glob in the text may start a word.
const ANY_WORD_START = new RegExp(`-|${LIVE}[*?[]`)

interface Expansion {
  end: number
  /** It may itself put an option-shaped word in. */
  unsafe: boolean
  /** A `$` form the reader does not know, so where it stops is unknown. */
  unknown: boolean
}

/** Text between expansions, glob marks kept, or one expansion. */
type Segment = { text: string } | Expansion

/** The text of the `${` body starting at `from`, up to its matching `}`, or undefined when it never closes. */
function braceBody(word: string, from: number): string | undefined {
  let depth = 1
  for (let at = from; at < word.length; at++) {
    if (word[at] === '{') depth++
    else if (word[at] === '}' && --depth === 0) return word.slice(from, at)
  }
  return undefined
}

/** Whether injected text may yield an option word once the shell splits it on `ifs`. */
function spellsOption(operand: string, ifs: string): boolean {
  if (!LITERAL.test(operand) || BRACE_WITH_DASH.test(operand)) return true
  // `--` anywhere counts, because an IFS set by an earlier call may split the text just before it.
  if (operand.includes('--')) return true
  const pieces = [...ifs].reduce((parts, blank) => parts.flatMap(part => part.split(blank)), [operand])
  return pieces.some(piece => piece.startsWith('-'))
}

/** Whether a `${...}` body may put an option-shaped word into the word, failing closed on any tail it cannot read. */
function mayInjectOption(body: string, ifs: string): boolean {
  if (LENGTH.test(body)) return false
  const rest = body.replace(HEAD, '')
  if (rest === '' || OFFSET.test(rest) || PLAIN_MODIFIERS.test(rest)) return false
  const trim = TRIM_OPERATOR.exec(rest)
  if (trim) return !PATTERN.test(rest.slice(trim[0].length))
  const operand = injectedOperand(rest)
  return operand === undefined || spellsOption(operand, ifs)
}

/** The text a value or replacement operator at the start of `rest` puts in the word, or undefined when it reads neither. */
function injectedOperand(rest: string): string | undefined {
  const value = VALUE_OPERATOR.exec(rest)
  if (value) return rest.slice(value[0].length)
  const replace = REPLACE_OPERATOR.exec(rest)
  if (!replace) return undefined
  const afterOperator = rest.slice(replace[0].length)
  const patternEnd = afterOperator.indexOf('/')
  const pattern = patternEnd < 0 ? afterOperator : afterOperator.slice(0, patternEnd)
  if (!PATTERN.test(pattern)) return undefined
  return patternEnd < 0 ? '' : afterOperator.slice(patternEnd + 1)
}

/** The index just past a `$(...)`, `$((...))` or backtick substitution at `at`, or undefined when it never closes. */
function substitutionEnd(word: string, at: number): number | undefined {
  if (word[at] === '`') {
    const close = word.indexOf('`', at + 1)
    return close < 0 ? undefined : close + 1
  }
  let depth = 0
  for (let index = at + 1; index < word.length; index++) {
    if (word[index] === '(') depth++
    else if (word[index] === ')' && --depth === 0) return index + 1
  }
  return undefined
}

const known = (end: number, unsafe: boolean): Expansion => ({ end, unsafe, unknown: false })

/** The expansion at `at`, just after a LIVE mark, with the index past it; undefined for a glob or `~`, which stay text. */
function readExpansion(word: string, at: number, ifs: string): Expansion | undefined {
  if (word.startsWith('${', at)) {
    const body = braceBody(word, at + 2)
    if (body === undefined) return known(word.length, true)
    return known(at + body.length + 3, mayInjectOption(body, ifs))
  }
  if (word.startsWith('$(', at) || word[at] === '`') {
    const end = substitutionEnd(word, at)
    return end === undefined ? known(word.length, true) : known(end, false)
  }
  const bare = BARE_PARAMETER.exec(word.slice(at))
  if (bare) return known(at + bare[0].length, false)
  return word[at] === '$' ? { end: at + 1, unsafe: false, unknown: true } : undefined
}

/** The marked word as text segments split around each expansion it holds. */
function segments(marked: string, ifs: string): Segment[] {
  const out: Segment[] = []
  let text = ''
  for (let at = 0; at < marked.length;) {
    const expansion = marked[at] === LIVE ? readExpansion(marked, at + 1, ifs) : undefined
    if (expansion) {
      out.push({ text }, expansion)
      text = ''
      at = expansion.end
    } else {
      text += marked[at]
      at++
    }
  }
  out.push({ text })
  return out
}

const BRACE_OPENER = `${LIVE}{`
const BRACE_SEPARATOR = /,|\.\./

/**
 * Whether any unquoted `{` in `marked` may open a brace expansion: a `,` or `..` follows it, or no `}`
 * does. Only `{` is marked, so a quoted `}` cannot be told from the closing one and the body is not parsed.
 */
function opensBraceExpansion(marked: string): boolean {
  for (let at = marked.indexOf(BRACE_OPENER); at >= 0; at = marked.indexOf(BRACE_OPENER, at + 1)) {
    const after = marked.slice(at + BRACE_OPENER.length)
    if (!after.includes('}') || BRACE_SEPARATOR.test(after)) return true
  }
  return false
}

/**
 * Whether `marked`, a word holding an expansion, may become an option word once the shell expands
 * and splits it on `ifs` (the line's IFS when it sets one): an expansion that may inject one, or
 * text that starts the word or follows an expansion and starts with `-` or a glob. After a `$` form
 * it does not know, a `-` or glob anywhere in the text that follows counts. A brace expansion makes
 * each alternative a copy of the word around it, so with an expansion beside it any `-` counts.
 */
export function operandMaySpellOption(marked: string, ifs = DEFAULT_IFS): boolean {
  const parts = segments(marked, ifs)
  if (parts.length === 1) return false
  if (marked.includes('-') && opensBraceExpansion(marked)) return true
  return parts.some((part, index) => {
    if (!('text' in part)) return part.unsafe
    if (index === 0) return WORD_START.test(part.text) && !OPTION_WITH_VALUE.test(part.text)
    const before = parts[index - 1]
    const unknownEnd = before !== undefined && 'unknown' in before && before.unknown
    return (unknownEnd ? ANY_WORD_START : WORD_START).test(part.text)
  })
}
