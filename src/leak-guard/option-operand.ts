/**
 * Whether a `${...}` in a marked word may expand to an option word such as `--no-verify` (CC-1286).
 * bash splits `main${X:- --no-verify}` into two words, and zsh does the same for `${=X:- …}`, so the
 * unexpanded text of the word never looks like an option. Only tails read in full count as safe;
 * any other `${...}` tail is taken to inject text.
 */
import { LIVE, NAME } from './shell-words.js'

const OPENER = `${LIVE}\${`
// zsh flags, a name, a positional or a special parameter, and an optional subscript. `!` is left out, so
// bash indirection such as ${!X:- -x} is never read and always denies.
const HEAD = new RegExp(`^[=~^]*(?:${NAME}|\\d+|[@*#?$-])(?:\\[[^\\]]*\\])?`)
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
// `--` anywhere counts, not only after a blank, because an IFS the line sets may split the word just before it.
const OPTION_SHAPE = /^-|\s-|--/
// A brace expansion such as `{a,-f}` or `{0..-1}` may start a word with any `-` it holds.
const BRACE_WITH_DASH = /[{}].*-|-.*[{}]/

/** The text of the `${` body starting at `from`, up to its matching `}`, or undefined when it never closes. */
function braceBody(word: string, from: number): string | undefined {
  let depth = 1
  for (let at = from; at < word.length; at++) {
    if (word[at] === '{') depth++
    else if (word[at] === '}' && --depth === 0) return word.slice(from, at)
  }
  return undefined
}

const spellsOption = (operand: string): boolean =>
  !LITERAL.test(operand) || OPTION_SHAPE.test(operand) || BRACE_WITH_DASH.test(operand)

/** Whether a `${...}` body may put an option-shaped word into the word, failing closed on any tail it cannot read. */
function mayInjectOption(body: string): boolean {
  if (LENGTH.test(body)) return false
  const rest = body.replace(HEAD, '')
  if (rest === '' || OFFSET.test(rest) || PLAIN_MODIFIERS.test(rest)) return false
  const trim = TRIM_OPERATOR.exec(rest)
  if (trim) return !PATTERN.test(rest.slice(trim[0].length))
  const operand = injectedOperand(rest)
  return operand === undefined || spellsOption(operand)
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

/** Whether any live `${...}` in `marked` may put an option-shaped word into it, or never closes. */
export function operandMaySpellOption(marked: string): boolean {
  for (let at = marked.indexOf(OPENER); at >= 0; at = marked.indexOf(OPENER, at + 1)) {
    const body = braceBody(marked, at + OPENER.length)
    if (body === undefined || mayInjectOption(body)) return true
  }
  return false
}
