/**
 * A best-effort POSIX shell word splitter for the PreToolUse guard (CC-270). It is not a shell:
 * it splits simple commands, removes quotes, and reads heredocs and command substitutions,
 * which is enough to see what an ordinary command line runs. Anything it misreads is a gap
 * in a speed bump, never a boundary; see docs/leak-guard.md.
 */

/** One simple command, its words with quotes removed, and any heredoc or here-string fed to it. */
export interface SimpleCommand {
  words: string[]
  stdin?: string
}

type Pending = 'discard' | 'herestring' | { heredoc: boolean }

interface Heredoc {
  delim: string
  strip: boolean
  target: SimpleCommand
}

const OPERATORS = new Set([';', '&', '|'])

const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }

class ShellLexer {
  pos: number
  private readonly out: SimpleCommand[] = []
  private cur: SimpleCommand = { words: [] }
  private word: string | null = null
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
    if (OPERATORS.has(c)) return this.skip(() => this.endCommand())
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
    this.pos++
    this.readHeredocs()
  }

  private paren(c: string): void {
    this.endCommand()
    if (c === ')' && this.nested && this.depth === 0) return void (this.closed = true)
    this.depth += c === '(' ? 1 : -1
    this.pos++
  }

  private skipComment(): void {
    const end = this.src.indexOf('\n', this.pos)
    this.pos = end < 0 ? this.src.length : end
  }

  private redirect(): void {
    if (this.word !== null && /^\d+$/.test(this.word)) this.word = null
    this.endWord()
    if (this.src.startsWith('<<<', this.pos)) return this.expect('herestring', 3)
    if (this.src.startsWith('<<', this.pos)) {
      const strip = this.src[this.pos + 2] === '-'
      return this.expect({ heredoc: strip }, strip ? 3 : 2)
    }
    this.pos++
    while ('>&|'.includes(this.src[this.pos] ?? '.')) this.pos++
    this.pending = 'discard'
  }

  private expect(pending: Pending, width: number): void {
    this.pending = pending
    this.pos += width
  }

  private wordPart(c: string): void {
    const next = this.src[this.pos + 1]
    if (c === "'") return this.append(this.until("'"))
    if (c === '"') return this.append(this.doubleQuoted())
    if (c === '$' && next === "'") return this.append(this.ansiC())
    if (c === '$' && next === '(') return this.append(this.substitution())
    if (c === '`') return this.append(this.backtick())
    if (c === '\\') {
      this.pos += 2
      return this.append(next ?? '')
    }
    this.pos++
    this.append(c)
  }

  private append(text: string): void {
    this.word = (this.word ?? '') + text
  }

  private until(quote: string): string {
    const end = this.src.indexOf(quote, this.pos + 1)
    const stop = end < 0 ? this.src.length : end
    const text = this.src.slice(this.pos + 1, stop)
    this.pos = stop + 1
    return text
  }

  private doubleQuoted(): string {
    let text = ''
    this.pos++
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      const c = this.src[this.pos] as string
      const next = this.src[this.pos + 1] ?? ''
      if (c === '$' && next === '(') text += this.substitution()
      else if (c === '`') text += this.backtick()
      else if (c === '\\' && '$`"\\\n'.includes(next)) {
        text += next === '\n' ? '' : next
        this.pos += 2
      } else {
        text += c
        this.pos++
      }
    }
    this.pos++
    return text
  }

  private ansiC(): string {
    this.pos++
    return this.until("'").replace(/\\(.)/g, (_, ch: string) => ANSI_C[ch] ?? `\\${ch}`)
  }

  /** Parses the inner commands too, so `$(git push --no-verify)` is seen; the word keeps the raw text. */
  private substitution(): string {
    const start = this.pos
    const inner = new ShellLexer(this.src, this.pos + 2, true)
    this.out.push(...inner.run())
    this.pos = Math.min(inner.pos + 1, this.src.length)
    return this.src.slice(start, this.pos)
  }

  private backtick(): string {
    const start = this.pos
    const body = this.until('`')
    this.out.push(...parseShell(body))
    return this.src.slice(start, this.pos)
  }

  private endWord(): void {
    if (this.word === null) return
    const word = this.word
    this.word = null
    const pending = this.pending
    this.pending = null
    if (pending === null) this.cur.words.push(word)
    else if (pending === 'herestring') this.cur.stdin = word
    else if (pending !== 'discard')
      this.heredocs.push({ delim: word, strip: pending.heredoc, target: this.cur })
  }

  private endCommand(): void {
    this.endWord()
    if (this.cur.words.length > 0) this.out.push(this.cur)
    this.cur = { words: [] }
  }

  private readHeredocs(): void {
    for (const doc of this.heredocs) doc.target.stdin = (doc.target.stdin ?? '') + this.heredocBody(doc)
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

/** Every simple command in `src`, including those inside `$(...)` and backticks. */
export function parseShell(src: string): SimpleCommand[] {
  return new ShellLexer(src).run()
}
