import { LIVE, unmark } from './shell-words.js'

/**
 * Whether a `git push` word's brace expansion may yield an option (CC-1427), such as
 * `--no-verif{y..y}`, `{main,--no-verify}` or `{,}--no-verify`. The group is read from the marked
 * word, where only an unquoted `{`, `,` or `}` carries LIVE, so `{,x"}"}--no-verify` closes where the
 * shell closes it. Read as option shapes, which fail closed, rather than as the exact expansion.
 */

// The group's structure, kept apart from the same characters written as text.
const OPEN = ''
const SEP = ''
const CLOSE = ''
const TEXT = `[^${OPEN}${SEP}${CLOSE}]`

// A comma list, or a sequence `{x..y}` or `{x..y..step}`; bash's is over integers or letters,
// zsh's over integers or any single characters.
const INTEGER_SEQUENCE = new RegExp(`${OPEN}-?\\d+\\.\\.-?\\d+(?:\\.\\.-?\\d+)?${CLOSE}`)
const CHAR_SEQUENCE = new RegExp(`${OPEN}(${TEXT})\\.\\.(${TEXT})(?:\\.\\.-?\\d+)?${CLOSE}`)
const CHAR_SEQUENCES = new RegExp(CHAR_SEQUENCE.source, 'g')
const BRACE_LIST = new RegExp(`${OPEN}[^${OPEN}${CLOSE}]*${SEP}[^${OPEN}${CLOSE}]*${CLOSE}`)
// An alternative, or a negative integer sequence, that starts with `-`.
const OPTION_ALTERNATIVE = new RegExp(`[${OPEN}${SEP}]-`)
// git's `-<n>`, as in `git log -{1..3}`, is a count, never an option that skips a hook or runs a program.
const COUNT = new RegExp(`^-[\\d.${OPEN}${SEP}${CLOSE}]+$`)
// Nesting deeper than this is read as both empty and leading with `-`.
const MAX_GROUP_DEPTH = 64

// The splitter leaves the `}` of an empty `{}` unmarked, so this is either that pair or a `{` before a quoted `}`.
const AMBIGUOUS_PAIR = `${LIVE}{}`
const MARKED_STRUCTURE = new RegExp(`${LIVE}[,}]`)

/** The word's text, with each `{`, `,` and `}` the shell reads as brace structure replaced by its sentinel. */
const structure = (marked: string): string =>
  unmark(marked.replaceAll(`${LIVE}{`, OPEN).replaceAll(`${LIVE},`, SEP).replaceAll(`${LIVE}}`, CLOSE))

/** The word read with `{}` as an empty pair, and read with it as a `{` before a quoted `}`. */
function readings(marked: string): string[] {
  if (!marked.includes(AMBIGUOUS_PAIR)) return [structure(marked)]
  return [structure(marked.replaceAll(AMBIGUOUS_PAIR, '{}')), structure(marked)]
}

/** Whether a zsh character sequence in `text`, such as `{+../}`, yields `-`. */
const sequenceYieldsDash = (text: string): boolean =>
  [...text.matchAll(CHAR_SEQUENCES)].some(([, from = '', to = '']) =>
    from <= to ? from <= '-' && '-' <= to : to <= '-' && '-' <= from,
  )

/** The index of the CLOSE that closes the OPEN at `open`, or -1. */
function closeOf(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === OPEN) depth++
    else if (text[i] === CLOSE && --depth === 0) return i
  }
  return -1
}

/** A group's alternatives, split at its top-level SEPs; one alternative when it has none. */
function topAlternatives(body: string): string[] {
  const alts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === OPEN) depth++
    else if (body[i] === CLOSE) depth--
    else if (body[i] === SEP && depth === 0) {
      alts.push(body.slice(from, i))
      from = i + 1
    }
  }
  alts.push(body.slice(from))
  return alts
}

/** The leading comma group of `text`: its alternatives and the text after it. */
function leadingGroup(text: string): { alts: string[]; rest: string } | undefined {
  const close = text.startsWith(OPEN) ? closeOf(text, 0) : -1
  const alts = close < 0 ? [] : topAlternatives(text.slice(1, close))
  return alts.length < 2 ? undefined : { alts, rest: text.slice(close + 1) }
}

/** Whether `text` may expand to an empty word: it is empty, or comma groups that each may be. */
function mayBeEmpty(text: string, depth: number): boolean {
  if (text === '' || depth > MAX_GROUP_DEPTH) return true
  const group = leadingGroup(text)
  return (
    group !== undefined && group.alts.some(alt => mayBeEmpty(alt, depth + 1)) && mayBeEmpty(group.rest, depth)
  )
}

/** Whether a word of `text`'s expansion may start with `-`, as `{,}--no-verify` and `{a,{,}}--no-verify` do. */
function mayLeadWithDash(text: string, depth = 0): boolean {
  if (text.startsWith('-') || depth > MAX_GROUP_DEPTH) return true
  const group = leadingGroup(text)
  if (group === undefined) return false
  const empty = group.alts.some(alt => mayBeEmpty(alt, depth + 1))
  return (
    group.alts.some(alt => mayLeadWithDash(alt, depth + 1)) ||
    (empty && mayLeadWithDash(group.rest, depth + 1))
  )
}

/** Whether the marked word holds a brace expansion that may yield an option, on either reading of a `{}`. */
export function braceOption(marked: string): boolean {
  if (!marked.includes(`${LIVE}{`)) return false
  // Several `{}` would need every mix of readings; with any brace structure beside them, fail closed.
  if (marked.split(AMBIGUOUS_PAIR).length > 2 && MARKED_STRUCTURE.test(marked)) return true
  return readings(marked).some(spellsOption)
}

function spellsOption(text: string): boolean {
  if (![INTEGER_SEQUENCE, CHAR_SEQUENCE, BRACE_LIST].some(group => group.test(text))) return false
  if (text.startsWith('-')) return !COUNT.test(text)
  return OPTION_ALTERNATIVE.test(text) || sequenceYieldsDash(text) || mayLeadWithDash(text)
}
