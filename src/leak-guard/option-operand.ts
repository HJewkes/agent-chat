/**
 * Whether a `${...}` default or replacement in a marked word may expand to an option word such as
 * `--no-verify` (CC-1286). bash splits `main${X:- --no-verify}` into two words, and zsh does the
 * same for `${=X:- …}`, so the unexpanded text of the word never looks like an option.
 */
import { LIVE, NAME, unmark } from './shell-words.js'

const OPENER = `${LIVE}\${`
// zsh flags, then a name, a positional or a special parameter, then an optional subscript.
const HEAD = new RegExp(`^[=~^]*(?:${NAME}|\\d+|[@*#?$!-])(?:\\[[^\\]]*\\])?`)
const VALUE_OPERATOR = /^(?:::=|:[-=+?]|[-=+?])/
const REPLACE_OPERATOR = /^(?::\/|\/[/#%]?)/
// zsh's history-style modifiers: `:s<d>…<d>…<d>`, `:gs`, `:&` and `:g&` put their own text into the value.
const MODIFIER = /^:[A-Za-z&]/
// Modifiers that only reshape the value, with no text of their own; any other is read as injecting.
const PLAIN_MODIFIERS = /^(?::[htreluqQaAP]\d*)+$/
// `--` anywhere counts, not only after a blank, because an IFS the line sets may split the word just before it.
const OPTION_SHAPE = /^-|\s-|--/

/** The text of the `${` body starting at `from`, up to its matching `}`, or undefined when it never closes. */
function braceBody(word: string, from: number): string | undefined {
  let depth = 1
  for (let at = from; at < word.length; at++) {
    if (word[at] === '{') depth++
    else if (word[at] === '}' && --depth === 0) return word.slice(from, at)
  }
  return undefined
}

/** Whether a `${...}` body may put an option-shaped word into the word beyond the variable's own value. */
function mayInjectOption(body: string): boolean {
  const rest = body.replace(HEAD, '')
  if (MODIFIER.test(rest)) return !PLAIN_MODIFIERS.test(rest)
  const operand = injectedOperand(rest)
  return operand !== undefined && OPTION_SHAPE.test(operand)
}

/** The text a value or replacement operator at the start of `rest` puts in the word, if it has any. */
function injectedOperand(rest: string): string | undefined {
  const value = VALUE_OPERATOR.exec(rest)
  if (value) return rest.slice(value[0].length)
  const replace = REPLACE_OPERATOR.exec(rest)
  if (!replace) return undefined
  const afterOperator = rest.slice(replace[0].length)
  const patternEnd = afterOperator.indexOf('/')
  return patternEnd < 0 ? undefined : afterOperator.slice(patternEnd + 1)
}

/** Whether any live `${...}` in `marked` has a value or replacement operand shaped like an option, or never closes. */
export function operandMaySpellOption(marked: string): boolean {
  for (let at = marked.indexOf(OPENER); at >= 0; at = marked.indexOf(OPENER, at + 1)) {
    const body = braceBody(marked, at + OPENER.length)
    if (body === undefined) return true
    if (mayInjectOption(unmark(body))) return true
  }
  return false
}
