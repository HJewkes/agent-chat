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
// `--` anywhere counts, not only after a blank: an IFS the line changes may split at any character.
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

/** The text a `${...}` body may put in the word beyond the variable's own value, if it has any. */
function injectedOperand(body: string): string | undefined {
  const rest = body.replace(HEAD, '')
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
    const operand = injectedOperand(unmark(body))
    if (operand !== undefined && OPTION_SHAPE.test(operand)) return true
  }
  return false
}
