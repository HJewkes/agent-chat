import { expandsToWords } from './git-unresolved.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * A `gh api` call with words the guard cannot resolve (CC-680). It is a GET, and posts nothing, only
 * when every flag is on a short allowlist, so no word, whatever it expands to, can be a method,
 * field or input flag, and each unresolved word is one word that cannot become flags.
 */

const BARE_FLAGS = new Set('--paginate --slurp --silent -i --include --verbose'.split(' '))
// Value flags, and whether the value may be a word the guard cannot resolve (a filter, not a request part).
const VALUE_FLAGS = new Map([
  ['-q', true],
  ['--jq', true],
  ['-t', true],
  ['--template', true],
  ['-H', false],
  ['--header', false],
  ['--hostname', false],
  ['--cache', false],
  ['-p', false],
  ['--preview', false],
])
// An attached filter whose value is an expansion: the literal `--jq=` opens the word.
const FILTER_PREFIX = /^--(?:jq|template)=/
// A relative GitHub REST path whose first segment after the collection is literal, so no expansion can
// form a scheme, a host or another API.
const REST_PREFIX = /^\/?(?:repos|orgs|users)\/[^/]+\//
const GRAPHQL = /^\/?graphql/i
const METHOD_OVERRIDE = /method|override/i

export type ApiRead = 'read' | 'splits' | 'other'

interface Word {
  marked: string
  value: string | undefined
}

/** Whether an attached `--flag=value` word's value may be unresolved; undefined when it is not a value flag. */
function attached(word: string): { name: string; value: string } | undefined {
  const eq = word.indexOf('=')
  if (!word.startsWith('--') || eq < 0) return undefined
  return { name: word.slice(0, eq), value: word.slice(eq + 1) }
}

/** The classification of a flag word and the width it takes, or 'other' when the allowlist does not hold it. */
function flagWidth(words: readonly Word[], i: number): number | 'other' {
  const { value, marked } = words[i] as Word
  if (value === undefined) return 'other'
  if (BARE_FLAGS.has(value)) return 1
  const open = VALUE_FLAGS.get(value)
  if (open !== undefined) {
    const next = words[i + 1]
    if (next === undefined) return 'other'
    if (next.value === undefined) return open ? 2 : 'other'
    return !open && (METHOD_OVERRIDE.test(next.value) || next.value.startsWith('-')) ? 'other' : 2
  }
  const glued = attached(value)
  const gluedOpen = glued && VALUE_FLAGS.get(glued.name)
  if (glued === undefined || gluedOpen === undefined) return 'other'
  const literal = !marked.slice(glued.name.length + 1).includes(LIVE)
  return literal && !METHOD_OVERRIDE.test(glued.value) && !glued.value.startsWith('-') ? 1 : 'other'
}

/** An endpoint is a REST path; one the guard cannot resolve must also be anchored by literal text before its first expansion. */
function anchored(word: Word, raw: string): boolean {
  if (GRAPHQL.test(raw) || raw.includes('://')) return false
  return word.value !== undefined || REST_PREFIX.test(word.marked.slice(0, word.marked.indexOf(LIVE)))
}

/**
 * Whether a `gh api` call that holds an unresolved word is a plain read. 'splits' means the only
 * fault is a word the shell may split into flags, which quoting fixes.
 */
export function classifyApiRead(
  marked: readonly string[],
  resolved: readonly (string | undefined)[],
  splits: readonly string[],
): ApiRead {
  const words = marked.map((m, i) => ({ marked: m, value: resolved[i] }))
  const splitSeen = words.slice(1).some(word => expandsToWords(word.marked, splits))
  let endpoints = 0
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as Word
    const raw = word.value ?? unmark(word.marked)
    // An endpoint the shell may fill in from a variable could be a flag, so it must open with literal text.
    const filter = word.value === undefined && FILTER_PREFIX.test(word.marked)
    if (word.value === undefined && !filter && (word.marked.startsWith(LIVE) || raw.startsWith('-')))
      return 'other'
    if (filter) continue
    if (!raw.startsWith('-')) {
      if (!anchored(word, raw)) return 'other'
      endpoints++
      continue
    }
    const width = flagWidth(words, i)
    if (width === 'other') return 'other'
    i += width - 1
  }
  if (endpoints !== 1) return 'other'
  return splitSeen ? 'splits' : 'read'
}
