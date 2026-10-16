import { LIVE } from './shell-words.js'

const isBlank = (c: string): boolean => c === ' ' || c === '\t'

/**
 * The words `env -S` makes of a marked value, by env's rules and not a shell's (CC-1340): blanks
 * split, quotes group, a `#` that starts a word ends the value, and `${NAME}` outside single quotes
 * expands, so that `$` comes back marked. `>`, `<`, `|`, `;` and `!` are plain characters to env, so
 * `git push --repo >! --no-verify` keeps every word. A word the outer shell marked keeps its marks.
 * Undefined for an unclosed quote, which env refuses. The caller refuses a backslash, and every blank
 * but space and tab, before this runs.
 */
export function envSplitWords(value: string): string[] | undefined {
  const words: string[] = []
  let word: string | undefined
  let quote = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string
    if (c === LIVE) word = `${word ?? ''}${c}${value[++i] ?? ''}`
    else if (quote === '' && isBlank(c)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else if (quote === '' && c === '#' && word === undefined) break
    else if (c === quote) quote = ''
    else if (quote === '' && (c === "'" || c === '"')) {
      quote = c
      word ??= ''
    } else word = `${word ?? ''}${c === '$' && quote !== "'" ? LIVE : ''}${c}`
  }
  if (quote !== '') return undefined
  if (word !== undefined) words.push(word)
  return words
}
