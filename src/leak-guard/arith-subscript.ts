/**
 * The variables a command's arithmetic re-evaluates (CC-1249). In `(( ))`, `$(( ))`, `$[ ]`, `let`, a
 * `declare -i` operand and an array subscript the shell evaluates a variable's value as arithmetic,
 * and some shells run a `$(...)` that value holds, so a substitution can arrive through a variable
 * the guard reads as a plain string. This lists the names; whether their values are safe is the
 * guard's question.
 */
import { LIVE, NAME, type SimpleCommand } from './shell-words.js'

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
function integerOperands(cmd: SimpleCommand): string[] {
  const [head = '', ...rest] = cmd.words
  if (head === 'let') return rest
  if (!INTEGER_DECLARERS.has(head) || !hasIntegerFlag(cmd.words)) return []
  return rest.filter(word => word.includes('=')).map(word => word.slice(word.indexOf('=') + 1))
}

/** Every name whose value `cmd` evaluates as arithmetic, each once, in the order first met. */
export function arithSubscriptNames(cmd: SimpleCommand): string[] {
  const texts = [...cmd.arithBodies, ...integerOperands(cmd), ...cmd.marked.flatMap(subscripts)]
  const names = texts.flatMap(text =>
    [...text.replace(SUBSTITUTION, ' ').matchAll(ARITH_NAME)].map(match => match[1] ?? match[2] ?? ''),
  )
  return [...new Set(names)]
}
