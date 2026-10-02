import { ansiCEscape } from './shell-words.js'

/**
 * Whether a command word the guard cannot resolve may still expand to git (TP-721): through a
 * glob (`gi?`), a brace expansion (`g{i,}t`), an ANSI-C string (`$'g\x69t'`) or a variable
 * spliced in that may be unset (`g${z}it`). A word that cannot become git, such as `./*.sh`, does not.
 */

const ANSI_C_STRING = /\$'((?:\\[\s\S]|[^'\\])*)'?/g
const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g
const QUOTING = /\\\n|['"\\]/g
// The `${x:-` of a default, so the word after it starts a segment of its own.
const EXPANSION_OPEN = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?])?/g
// A run of characters one path segment can hold, where a glob bracket may hold a class such as [[:alpha:]].
const SEGMENT = /(?:[\w.?*-]|\[(?:\[:\w+:\]|[^\]/])*\])+/g
const PIECE = /\[(?:\[:\w+:\]|[^\]/])*\]|[\s\S]/g
const INNERMOST_BRACE = /\{([^{}]*)\}/
const RANGE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.-?\d+)?$/
const MAX_WORDS = 256

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

/** The words a brace body stands for, or undefined when it is not an expansion, as `{x}` is not. */
function alternatives(body: string): string[] | undefined {
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

/** Every word brace expansion may make of `word`, innermost braces first; a brace that does not expand splits segments. */
function braceWords(word: string): string[] {
  const words: string[] = []
  const pending = [word]
  while (pending.length > 0) {
    if (words.length + pending.length > MAX_WORDS) return ['*']
    const next = pending.pop() as string
    const brace = INNERMOST_BRACE.exec(next)
    if (brace === null) {
      words.push(next)
      continue
    }
    const [before, after] = [next.slice(0, brace.index), next.slice(brace.index + brace[0].length)]
    const alts = alternatives(brace[1] as string)
    if (alts === undefined) pending.push(`${before} ${brace[1]} ${after}`)
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

function segmentMatchesGit(segment: string): boolean {
  const pieces = segment.match(PIECE) ?? []
  const source = pieces.map(piece =>
    piece === '?' ? '.' : piece === '*' ? '.*' : piece.length > 1 ? bracketClass(piece) : escapeRegExp(piece),
  )
  try {
    return new RegExp(`^${source.join('')}$`).test('git')
  } catch {
    return true
  }
}

export function mayExpandToGit(raw: string): boolean {
  const plain = decodeAnsiC(raw).replace(REFERENCE, '').replace(EXPANSION_OPEN, ' ').replace(QUOTING, '')
  return braceWords(plain).some(word => (word.match(SEGMENT) ?? []).some(segmentMatchesGit))
}
