/**
 * A best-effort POSIX shell word splitter for the PreToolUse guard (CC-270). It is not a shell:
 * it splits simple commands, removes quotes, and reads heredocs and command substitutions,
 * which is enough to see what an ordinary command line runs. Anything it misreads is a gap
 * in a speed bump, never a boundary; see docs/leak-guard.md.
 */

/** Precedes each `$`, leading `~`, glob character and substitution the shell would expand in a marked word. */
export const LIVE = '\0'

export const unmark = (word: string): string => word.replaceAll(LIVE, '')

/** One `$(...)` or backtick pair: its source text and the commands inside it. */
export interface Substitution {
  raw: string
  commands: SimpleCommand[]
  /** Inside double quotes, so the shell does not split or glob what it prints. */
  quoted: boolean
}

/** One simple command, its words with quotes removed, and any heredoc or here-string fed to it. */
export interface SimpleCommand {
  words: string[]
  /** The same words with LIVE before each character the shell would expand, so quoting is not lost. */
  marked: string[]
  substitutions: Substitution[]
  stdin?: string
  /** The shell expands `stdin`, reads it from a redirect the splitter does not follow, or has two sources for it. */
  stdinLive: boolean
  /** The operator joining this command to the one before it and after it; '' at either end. */
  before: string
  after: string
  /** Inside parentheses or a substitution, so it runs in a subshell. */
  nested: boolean
}

/** `aside` marks a heredoc on a descriptor other than 0, which is read past and never fed as stdin. */
type Pending = 'discard' | 'herestring' | { strip: boolean; aside: boolean }

interface Heredoc {
  delim: string
  strip: boolean
  aside: boolean
  quoted: boolean
  target: SimpleCommand
}

const OPERATORS = new Set([';', '&', '|'])
const GLOB = '*?[{'
const BLANK = new Set([' ', '\t', '\n', ';', undefined])
// gh fills these in a `gh api` path itself; no shell expands a brace group that has no comma.
const GH_PLACEHOLDERS = ['{owner}', '{repo}', '{branch}']
// In a heredoc with an unquoted delimiter the shell expands these and joins a line ending in a backslash.
const HEREDOC_LIVE = /[$`\\]/

const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }

class ShellLexer {
  pos: number
  private readonly out: SimpleCommand[] = []
  private cur: SimpleCommand
  private last: SimpleCommand | undefined
  private joiner = ''
  private word: string | null = null
  private marked = ''
  private quoted = false
  private pending: Pending | null = null
  private heredocs: Heredoc[] = []
  private depth = 0
  private closed = false

  constructor(
    private readonly src: string,
    start = 0,
    private readonly nested = false,
  ) {
    this.pos = start
    this.cur = this.newCommand()
  }

  private newCommand(): SimpleCommand {
    const nested = this.nested || this.depth !== 0
    return { words: [], marked: [], substitutions: [], stdinLive: false, before: '', after: '', nested }
  }

  run(): SimpleCommand[] {
    while (this.pos < this.src.length && !this.closed) this.step()
    this.endCommand()
    return this.out
  }

  private step(): void {
    const c = this.src[this.pos] as string
    if (c === '\\' && this.src[this.pos + 1] === '\n') return void (this.pos += 2)
    if (c === ' ' || c === '\t') return this.skip(() => this.endWord())
    if (c === '\n') return this.newline()
    if (c === '(' || c === ')') return this.paren(c)
    if (OPERATORS.has(c)) return this.operator(c)
    if (c === '#' && this.word === null) return this.skipComment()
    if (c === '<' || c === '>') return this.redirect()
    this.wordPart(c)
  }

  private skip(then: () => void): void {
    then()
    this.pos++
  }

  private newline(): void {
    this.endCommand()
    this.join('\n')
    this.pos++
    this.readHeredocs()
  }

  private operator(c: string): void {
    const op = c !== ';' && this.src[this.pos + 1] === c ? c + c : c
    this.endCommand()
    this.join(op)
    this.pos += op.length
  }

  /** A newline after `&&`, `||` or `|` continues the list, so it never replaces that operator. */
  private join(op: string): void {
    if (this.joiner === '') this.joiner = op
    if (this.last !== undefined && this.last.after === '') this.last.after = op
  }

  /** `name(`, `name ()` and `<(`: a glob qualifier, a function and a process substitution, none modelled. */
  private paren(c: string): void {
    const fed = c === '(' && this.word === null && this.pending !== null
    if (fed) this.pending = null
    if (fed || (c === '(' && this.word !== null)) this.append('', true)
    this.endWord()
    const defined = this.cur.marked.length - 1
    if (defined >= 0 && /^\(\s*\)/.test(this.src.slice(this.pos))) this.cur.marked[defined] += LIVE
    this.endCommand()
    if (c === ')' && this.nested && this.depth === 0) return void (this.closed = true)
    this.depth += c === '(' ? 1 : -1
    this.pos++
    this.cur = this.newCommand()
  }

  private skipComment(): void {
    const end = this.src.indexOf('\n', this.pos)
    this.pos = end < 0 ? this.src.length : end
  }

  private redirect(): void {
    const range = /^<\d*-\d*>/.exec(this.src.slice(this.pos))?.[0]
    if (range !== undefined) return this.globRange(range)
    const aside = this.descriptor() > 0
    this.endWord()
    if (this.src.startsWith('<<<', this.pos)) return this.expect(aside ? 'discard' : 'herestring', 3)
    if (this.src.startsWith('<<', this.pos)) {
      const strip = this.src[this.pos + 2] === '-'
      return this.expect({ strip, aside }, strip ? 3 : 2)
    }
    if (this.src[this.pos] === '<' && !aside) this.cur.stdinLive = true
    this.pos++
    while ('>&|'.includes(this.src[this.pos] ?? '.')) this.pos++
    this.pending = 'discard'
  }

  /** The number an unquoted digit word gives a redirect, such as the 3 of `3<<EOF`; -1 when there is none. */
  private descriptor(): number {
    if (this.word === null || this.quoted || !/^\d+$/.test(this.word)) return -1
    const fd = Number(this.word)
    this.word = null
    return fd
  }

  /** zsh matches `<1-9>` against file names, so it is a glob and not two redirects. */
  private globRange(range: string): void {
    this.pos += range.length
    this.append(range, true)
  }

  private expect(pending: Pending, width: number): void {
    this.pending = pending
    this.pos += width
  }

  private wordPart(c: string): void {
    const next = this.src[this.pos + 1]
    this.quoted ||= c === "'" || c === '"' || c === '\\'
    if (c === "'") return this.append(this.until("'"))
    if (c === '"') return this.doubleQuoted()
    if (c === '$' && next === "'") return this.ansiC()
    if (c === '$' && next === '(') return this.append(this.substitution(false), true)
    if (c === '$' && next === '{') return this.append(this.braced(), true)
    if (c === '`') return this.append(this.backtick(false), true)
    if (c === '\\') {
      this.pos += 2
      return this.append(next ?? '')
    }
    this.pos++
    this.append(c, this.expands(c, next))
  }

  /** A `{` or `}` alone is a group, not a brace expansion; a leading `=` is zsh's command path. */
  private expands(c: string, next: string | undefined): boolean {
    const starts = this.word === null
    if ((c === '{' || c === '}') && starts && BLANK.has(next)) return false
    if (GH_PLACEHOLDERS.some(name => this.src.startsWith(name, this.pos - 1))) return false
    return c === '$' || GLOB.includes(c) || (starts && (c === '~' || c === '='))
  }

  private braced(): string {
    const end = this.src.indexOf('}', this.pos)
    const stop = end < 0 ? this.src.length : end + 1
    const text = this.src.slice(this.pos, stop)
    this.pos = stop
    return text
  }

  private append(text: string, live = false): void {
    this.marked = (this.word === null ? '' : this.marked) + (live ? LIVE : '') + text
    this.word = (this.word ?? '') + text
  }

  private until(quote: string): string {
    const end = this.src.indexOf(quote, this.pos + 1)
    const stop = end < 0 ? this.src.length : end
    const text = this.src.slice(this.pos + 1, stop)
    this.pos = stop + 1
    return text
  }

  private doubleQuoted(): void {
    this.append('')
    this.pos++
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      const c = this.src[this.pos] as string
      const next = this.src[this.pos + 1] ?? ''
      if (c === '$' && next === '(') this.append(this.substitution(true), true)
      else if (c === '`') this.append(this.backtick(true), true)
      else if (c === '\\' && '$`"\\\n'.includes(next)) {
        this.append(next === '\n' ? '' : next)
        this.pos += 2
      } else {
        this.append(c, c === '$')
        this.pos++
      }
    }
    this.pos++
  }

  /** An escape outside the table, such as `\x65`, stays LIVE: the splitter does not decode it. */
  private ansiC(): void {
    this.append('')
    this.pos += 2
    while (this.pos < this.src.length && this.src[this.pos] !== "'") {
      const c = this.src[this.pos] as string
      const next = this.src[this.pos + 1] ?? ''
      if (c === '\\') this.append(ANSI_C[next] ?? next, ANSI_C[next] === undefined)
      else this.append(c)
      this.pos += c === '\\' ? 2 : 1
    }
    this.pos++
  }

  /** Parses the inner commands too, so `$(git push --no-verify)` is seen; the word keeps the raw text. */
  private substitution(quoted: boolean): string {
    const start = this.pos
    const inner = new ShellLexer(this.src, this.pos + 2, true)
    const commands = inner.run()
    this.pos = Math.min(inner.pos + 1, this.src.length)
    return this.substituted(this.src.slice(start, this.pos), commands, quoted)
  }

  private backtick(quoted: boolean): string {
    const start = this.pos
    const commands = new ShellLexer(this.until('`'), 0, true).run()
    return this.substituted(this.src.slice(start, this.pos), commands, quoted)
  }

  private substituted(raw: string, commands: SimpleCommand[], quoted: boolean): string {
    this.out.push(...commands)
    this.cur.substitutions.push({ raw, commands, quoted })
    return raw
  }

  private endWord(): void {
    if (this.word === null) return
    const word = this.word
    const quoted = this.quoted
    this.word = null
    this.quoted = false
    const pending = this.pending
    this.pending = null
    if (pending === null) {
      this.cur.words.push(word)
      this.cur.marked.push(this.marked)
    } else if (pending === 'herestring') this.feed(this.cur, word, this.marked.includes(LIVE))
    else if (pending !== 'discard')
      this.heredocs.push({ delim: word, ...pending, quoted, target: this.cur })
  }

  /** zsh feeds a command every heredoc and here-string it is given and bash only the last, so a second one is unsure. */
  private feed(target: SimpleCommand, text: string, live: boolean): void {
    target.stdinLive ||= live || target.stdin !== undefined
    target.stdin = (target.stdin ?? '') + text
  }

  private endCommand(): void {
    this.endWord()
    if (this.cur.words.length > 0) {
      this.cur.before = this.joiner
      this.joiner = ''
      this.last = this.cur
      this.out.push(this.cur)
    }
    this.cur = this.newCommand()
  }

  private readHeredocs(): void {
    for (const doc of this.heredocs) {
      const body = this.heredocBody(doc)
      if (!doc.aside) this.feed(doc.target, body, !doc.quoted && HEREDOC_LIVE.test(body))
    }
    this.heredocs = []
  }

  private heredocBody({ delim, strip }: Heredoc): string {
    const lines: string[] = []
    while (this.pos < this.src.length) {
      const end = this.src.indexOf('\n', this.pos)
      const stop = end < 0 ? this.src.length : end
      const line = this.src.slice(this.pos, stop)
      this.pos = stop + 1
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) break
      lines.push(line)
    }
    return lines.join('\n')
  }
}

/** Stands in for a substitution while the rest of its word is expanded; a word that holds one already does not resolve. */
export const HOLE = '\x01'

/** Every simple command in `src`, including those inside `$(...)` and backticks. */
export function parseShell(src: string): SimpleCommand[] {
  return new ShellLexer(unmark(src)).run()
}

export const NAME = '[A-Za-z_][A-Za-z0-9_]*'
// zsh reads `$NAME:h` and `$NAME[1]` as a modifier and a subscript, even inside double quotes.
const BARE = `\\$(${NAME})(?![A-Za-z0-9_]|${LIVE}?[:\\[])`
const EXPANSION = new RegExp(`${LIVE}(?:\\$\\{(${NAME})\\}|${BARE}|~(?=/|$))`, 'g')
// An unquoted value that is empty, or holds blanks or glob characters, becomes other words.
const ONE_WORD = /^[^\s*?[\]{}]+$/

/** A marked word as the shell expands it, or undefined unless every expansion is `~`, `$VAR` or `${VAR}` with a one-word value. */
export function expandWord(
  marked: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let known = true
  const expanded = marked.replace(EXPANSION, (_, braced?: string, bare?: string) => {
    const value = env[braced ?? bare ?? 'HOME'] ?? ''
    known &&= ONE_WORD.test(value)
    return value
  })
  return known && !expanded.includes(LIVE) ? expanded : undefined
}
