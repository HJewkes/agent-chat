import { ansiCEscape } from './shell-words.js'

/**
 * Whether a command word the guard cannot resolve may still expand to git (TP-721): through a
 * glob (`gi?`), a brace expansion (`g{i,}t`), zsh alternation (`g(i|x)t`), an ANSI-C string
 * (`$'g\x69t'`) or a variable spliced in that may be unset (`g${z}it`). A word that cannot become
 * git, such as `./*.sh`, does not. A word too long or too branching to check ties, so it fails closed.
 */

const ANSI_C_STRING = /\$'((?:\\[\s\S]|[^'\\])*)'?/g
const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g
const QUOTING = /\\\n|['"\\]/g
// The `${x:-` of a default or the `${x#` of a trim, whose text may stand in for the whole expansion.
const EXPANSION_OPEN = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?]|#{1,2}|%{1,2}|\/[/#%]?|\^{1,2}|,{1,2})?/g
const DEFAULT = '\x02'
// A glob bracket, where a `]` first (after `!` or `^`) is a member and a class such as [:alpha:] may sit inside.
const BRACKET = String.raw`\[[!^]?\]?(?:\[:\w+:\]|[^\]/])*\]`
const SEGMENT = new RegExp(String.raw`(?:[\w.?*#-]|${BRACKET})+`, 'g')
const PIECE = new RegExp(String.raw`${BRACKET}|[\s\S]`, 'g')
const INNERMOST_GROUP = /[{(]([^{}()]*)[})]/
const RANGE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.-?\d+)?$/
const MAX_LENGTH = 1024
const MAX_WORDS = 256
const MAX_STEPS = 4096

function decodeAnsiC(text: string): string {
  return text.replace(ANSI_C_STRING, (_, body: string) => {
    let out = ''
    for (let i = 0; i < body.length;) {
      const escape = body[i] === '\\' ? ansiCEscape(body, i) : { text: body[i] as string, width: 1 }
      out += escape.text
      i += escape.width
    }
    return out
  })
}

/** The words a `{...}` or zsh `(...)` body stands for, or undefined when it is not an expansion, as `{x}` is not. */
function alternatives(open: string, body: string): string[] | undefined {
  // A group may also be glob qualifiers such as `(N)`, which zsh drops, wherever its word ends.
  if (open === '(') return [...body.split('|'), '']
  // An unset variable leaves the default; a set one is read as unset too, like `$NAME`.
  if (body.startsWith(DEFAULT)) return [body.slice(1), '']
  const range = RANGE.exec(body)
  // A numeric range yields only digits, which never spell git.
  if (range?.[1] !== undefined) return ['0']
  if (range?.[3] !== undefined) {
    const [from, to] = [range[3].charCodeAt(0), (range[4] as string).charCodeAt(0)]
    const codes = Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => Math.min(from, to) + i)
    return codes.map(code => String.fromCharCode(code))
  }
  return body.includes(',') ? body.split(',') : undefined
}

/** Every word expansion may make of `word`, innermost group first; a group that does not expand splits segments. */
function expandedWords(word: string): string[] {
  const words: string[] = []
  const pending = [word]
  for (let steps = 0; pending.length > 0; steps++) {
    if (steps > MAX_STEPS || words.length + pending.length > MAX_WORDS) return ['*']
    const next = pending.pop() as string
    const group = INNERMOST_GROUP.exec(next)
    if (group === null) {
      words.push(next)
      continue
    }
    const [before, after] = [next.slice(0, group.index), next.slice(group.index + group[0].length)]
    const alts = alternatives(group[0][0] as string, group[1] as string)
    if (alts === undefined) pending.push(`${before} ${group[1]} ${after}`)
    else pending.push(...alts.map(alt => before + alt + after))
  }
  return words
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

/** A glob bracket as a regex class; a POSIX class such as [:alpha:] is read as any character. */
function bracketClass(bracket: string): string {
  const body = bracket.slice(1, -1)
  if (body.includes('[:')) return '.'
  const negated = /^[!^]/.test(body)
  const members = (negated ? body.slice(1) : body).replace(/[\\\]^[]/g, '\\$&')
  return `[${negated ? '^' : ''}${members}]`
}

/** One glob piece as regex; zsh's `#` repeats the piece before it, and a second `#` adds nothing here. */
function pieceSource(piece: string, previous: string | undefined): string {
  if (piece === '#') return previous === undefined || previous === '' || previous.endsWith('*') ? '' : '*'
  if (piece === '?') return '.'
  if (piece === '*') return '.*'
  return piece.length > 1 ? bracketClass(piece) : escapeRegExp(piece)
}

function segmentMatchesGit(segment: string): boolean {
  const source: string[] = []
  for (const piece of segment.match(PIECE) ?? []) source.push(pieceSource(piece, source.at(-1)))
  try {
    return new RegExp(`^${source.join('')}$`).test('git')
  } catch {
    return true
  }
}

export function mayExpandToGit(raw: string): boolean {
  if (raw.length > MAX_LENGTH) return true
  const plain = decodeAnsiC(raw)
    .replace(REFERENCE, '')
    .replace(EXPANSION_OPEN, `{${DEFAULT}`)
    .replace(QUOTING, '')
  return expandedWords(plain).some(word => (word.match(SEGMENT) ?? []).some(segmentMatchesGit))
}
