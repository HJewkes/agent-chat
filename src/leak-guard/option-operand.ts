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
const HEAD = new RegExp(`^[=~^]*(?:${NAME}|\\d+|[@*#?$-])(?:\\[[\\w@*#+,-]*\\])?`)
// A special parameter must not run into a name (zsh reads `$#X` and `$+X` as one expansion), and no
// parameter may take a zsh subscript or modifier; such a `$` is read as an unknown expansion. Each
// alternative ends at a true token boundary, so a rejected `$AB:s` cannot backtrack into `$A`.
const BARE_PARAMETER = new RegExp(
  `^\\$(?:${NAME}(?!\\w)|\\d+(?!\\d)|[@*#?$!-](?![\\w{]))(?![\\[]|:[A-Za-z&])`,
)
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

// A word's unquoted `{` is marked; an operand inside `${...}` carries no marks, so any `{` there counts.
const LIVE_BRACE = `${LIVE}{`
const OPERAND_BRACE = '{'
// `{}` with no `}` after it is the one brace that never expands.
const EMPTY_BRACES = /^\}[^}]*$/

/**
 * Whether `text` holds an `opener` that may start a brace expansion. zsh's braceccl expands any
 * `{chars}` and a range such as `{+../}` makes a `-` of its own, so every `{` but a lone `{}` counts,
 * including one with no `}` after it. A quoted `}` cannot be told from the closing one, so the body
 * is not parsed.
 */
function mayBraceExpand(text: string, opener: string): boolean {
  for (let at = text.indexOf(opener); at >= 0; at = text.indexOf(opener, at + 1)) {
    if (!EMPTY_BRACES.test(text.slice(at + opener.length))) return true
  }
  return false
}

/** Whether injected text may yield an option word once the shell splits it on `ifs`. */
function spellsOption(operand: string, ifs: string): boolean {
  if (!LITERAL.test(operand) || mayBraceExpand(operand, OPERAND_BRACE)) return true
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

// A `$(...)` or backtick substitution read in full: one plain command with no quote, escape, nested
// expansion, paren, backtick, comment or redirect, whose first word does not open a compound command
// (the splitter ends `$(case a in a) …` at the pattern's `)`). Any other may end elsewhere, so it denies.
const PLAIN_COMMAND = String.raw`(?!\s*(?:case|if|for|while|until|select|function|time|coproc|repeat|foreach)\b)[\w\s.,/@%+=:-]*`
const PLAIN_SUBSTITUTION = new RegExp(`^(?:\\$\\(${PLAIN_COMMAND}\\)|\`${PLAIN_COMMAND}\`)`)
// The other marks that stay text: a glob, a leading `~` and a brace, which is judged on its own.
const TEXT_MARK = /^[*?[~{]/

const known = (end: number, unsafe: boolean): Expansion => ({ end, unsafe, unknown: false })

/**
 * The expansion at `at`, just after a LIVE mark, with the index past it, or undefined for a mark that
 * stays text. A mark it cannot read in full is an unsafe expansion to the end of the word.
 */
function readExpansion(word: string, at: number, ifs: string): Expansion | undefined {
  if (word.startsWith('${', at)) {
    const body = braceBody(word, at + 2)
    if (body === undefined) return known(word.length, true)
    return known(at + body.length + 3, mayInjectOption(body, ifs))
  }
  if (word.startsWith('$(', at) || word[at] === '`') {
    const plain = PLAIN_SUBSTITUTION.exec(word.slice(at))
    return plain ? known(at + plain[0].length, false) : known(word.length, true)
  }
  const bare = BARE_PARAMETER.exec(word.slice(at))
  if (bare) return known(at + bare[0].length, false)
  if (word[at] === '$') return { end: at + 1, unsafe: false, unknown: true }
  return TEXT_MARK.test(word.slice(at)) ? undefined : known(word.length, true)
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

/**
 * Whether `marked`, a word holding an expansion, may become an option word once the shell expands
 * and splits it on `ifs` (the line's IFS when it sets one): an expansion that may inject one, or
 * text that starts the word or follows an expansion and starts with `-` or a glob. After a `$` form
 * it does not know, a `-` or glob anywhere in the text that follows counts. A brace expansion makes
 * each alternative a copy of the word around it, and a zsh range such as `{+../}` makes a `-` of its own,
 * so with an expansion beside it the word denies.
 */
export function operandMaySpellOption(marked: string, ifs = DEFAULT_IFS): boolean {
  const parts = segments(marked, ifs)
  if (parts.length === 1) return false
  if (mayBraceExpand(marked, LIVE_BRACE)) return true
  return parts.some((part, index) => {
    if (!('text' in part)) return part.unsafe
    if (index === 0) return WORD_START.test(part.text) && !OPTION_WITH_VALUE.test(part.text)
    const before = parts[index - 1]
    const unknownEnd = before !== undefined && 'unknown' in before && before.unknown
    return (unknownEnd ? ANY_WORD_START : WORD_START).test(part.text)
  })
}
