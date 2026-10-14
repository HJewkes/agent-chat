/**
 * A best-effort POSIX shell word splitter for the PreToolUse guard (CC-270). It is not a shell:
 * it splits simple commands, removes quotes, and reads heredocs, command substitutions and
 * bash 5.3's `${ cmd;}` / `${|cmd;}` (funsub), which is enough to see what an ordinary command
 * line runs. Anything it misreads is a gap in a speed bump, never a boundary; see docs/leak-guard.md.
 */

/** Precedes each `$`, leading `~`, glob character and substitution the shell would expand in a marked word. */
export const LIVE = '\0'

export const unmark = (word: string): string => word.replaceAll(LIVE, '')

/** One `$(...)`, backtick pair or funsub: its source text and the commands inside it. */
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
  /** The `marked` words that hold an unquoted `$`, substitution, backtick or glob, which the shell splits into words. */
  splits: string[]
  substitutions: Substitution[]
  stdin?: string
  /** The shell expands `stdin`, reads it from a redirect the splitter does not follow, or has two sources for it. */
  stdinLive: boolean
  /** The marked targets of its output redirects (`>`, `>>`, `&>`), including those of a bare redirect before it. */
  writes: string[]
  /** A heredoc fed to it holds a backslash the shell rewrites, which is why `stdin` is unsure. */
  backslash: boolean
  /** The operator joining this command to the one before it and after it; '' at either end. */
  before: string
  after: string
  /** Inside parentheses or a substitution, so it runs in a subshell. */
  nested: boolean
  /** Inside the body of a `(( ))` or `$(( ))` the shell evaluates as arithmetic, not as a command (CC-1249). */
  arith: boolean
  /**
   * The raw text of each arithmetic it evaluates: its own body when `arith`, and each `$(( ))` and `$[ ]`
   * in its words, with substitutions blanked. Splitting into words would read `<y` as a redirect.
   */
  arithBodies: string[]
}

/** The arithmetic a lexer is inside: commands at `depth` or deeper are its body. */
interface Arith {
  depth: number
  text: string
}

/** `aside` marks a heredoc on a descriptor other than 0, which is read past and never fed as stdin. */
type Pending = 'discard' | 'write' | 'herestring' | { strip: boolean; aside: boolean }

interface Heredoc {
  delim: string
  strip: boolean
  aside: boolean
  quoted: boolean
  target: SimpleCommand
}

const OPERATORS = new Set([';', '&', '|'])
const WRITE_OPERATORS = new Set(['>', '>>', '>|', '<>', '&>', '&>>'])
const GLOB = '*?[{'
// A group the splitter can end without doubt: no quote, escape, blank, `$`, backtick or operator inside.
const PLAIN_GROUP = /^\([^\s()'"\\`$;&<>]*\)$/
const MAX_FORKS = 64

/** The commands after `after`, bar `skip`, are checked when the span is not settled. */
interface Mark {
  after: number
  skip: SimpleCommand
}

/**
 * Shared by every lexer of one parse, so a line of many groups ends in a deny and not in a long run,
 * and a `${...}` met inside a substitution still counts; see `expansionRisk`.
 */
interface Budget {
  forks: number
  expansion: ExpansionRisk | undefined
  /** Only finding where a substitution ends, so arithmetic is not looked for. */
  probe?: boolean
}

/**
 * `operator`: a `${...}` with an operator, a leading `#` or `!`, which the splitter reads up to its
 * first `}`. `unreadable`: one holding a quote, an escape, a nested `$` or a zsh flag group, or a nested
 * `{` whose close zsh finds past a blank, quote or operator, where that first `}` may not be the shell's,
 * so the rest of the line is not what the shell runs.
 */
export type ExpansionRisk = 'operator' | 'unreadable'

// The only `${...}` forms the splitter reads as the shell does.
const PLAIN_BRACED = /^\$\{(?:[A-Za-z_][A-Za-z0-9_]*|\d+)\}$/
const UNREADABLE_BRACED = /^\$\{(?:\(|[\s\S]*\$)|['"`\\]/
// Text that keeps one word whichever `}` closes the expansion.
const SAME_WORD = /^[^\s'"`\\$#;&|<>()]*$/

/** Where zsh closes the `${` at `start`: it counts nested braces, where bash and the splitter stop at the first `}`. */
function nestedClose(src: string, start: number): number {
  let depth = 0
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** `at`, moved past any backslash-newline, which bash removes before it reads tokens. */
function unjoinAt(src: string, at: number): number {
  while (src.startsWith('\\\n', at)) at += 2
  return at
}

/** The index after the `n` characters from `at` as bash reads them. */
function skipChars(src: string, at: number, n: number): number {
  for (let i = 0; i < n; i++) at = unjoinAt(src, unjoinAt(src, at) + 1)
  return at
}

/** Where the body of a funsub opening at `at` starts: `${` and a blank, tab or newline, or `${|`. */
function funsubBody(src: string, at: number): number | undefined {
  const brace = unjoinAt(src, at + 1)
  if (src[at] !== '$' || src[brace] !== '{') return undefined
  const open = unjoinAt(src, brace + 1)
  const c = src[open] ?? ''
  if (c === '|') return open + 1
  return c !== '' && ' \t\n'.includes(c) ? open : undefined
}

// What a `(` starts: only in a subshell can `{` and `}` still be reserved words.
type ParenKind = 'subshell' | 'function' | 'header' | 'arith' | 'text'

/** bash's reserved words, each mapped to whether a command may start after it, as after `then`. */
const RESERVED = new Map<string, boolean>([
  ...['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', '!', '{', 'coproc'].map(
    w => [w, true] as const,
  ),
  ...['fi', 'done', 'esac', '}', '[[', ']]', 'case', 'for', 'select', 'function', 'in'].map(
    w => [w, false] as const,
  ),
])

/**
 * A token as bash's parser records it in last_read_token: a reserved word or operator by its text,
 * `\n`, `(`, `)`, or one of the names below; undefined is the start of a command list (token 0).
 */
type Token = string | undefined
const WORD = 'WORD'
const ASSIGNMENT_WORD = 'ASSIGNMENT_WORD'
// `-p` and `--` right after `time`, and `--` after `time -p` (parse.y 3471-3481).
const TIMEOPT = 'TIMEOPT'
const TIMEIGN = 'TIMEIGN'
// The `))` that ends `(( ))` and the one that ends `for (( ))`.
const ARITH_CMD = 'ARITH_CMD'
const ARITH_FOR_EXPRS = 'ARITH_FOR_EXPRS'
// Operators the reader lexes as one token, longest first.
const OPERATOR_TOKENS = [';;&', ';;', ';&', '&&', '||', '|&']
const CASE_ENDS = new Set<Token>([';;', ';&', ';;&'])

/**
 * The tokens after which bash 5.3 recognises a reserved word: reserved_word_acceptable, parse.y 5896-5947.
 * undefined stands for token 0 and for the DOLPAREN or DOLBRACE that opens a substitution's body.
 */
const RESERVED_ACCEPTABLE = new Set<Token>([
  ...['\n', ';', '(', ')', '|', '&', '{', '}', '&&', ARITH_CMD, '!', '|&', ']]', 'do', 'done'],
  ...['elif', 'else', 'esac', 'fi', 'if', '||', ';;', ';&', ';;&', 'then', 'time', TIMEOPT],
  ...[TIMEIGN, 'coproc', 'until', 'while', undefined],
])

function reservedWordAcceptable(last: Token, before: Token): boolean {
  if (RESERVED_ACCEPTABLE.has(last)) return true
  // The default case: the NAME of `coproc NAME` and of `function NAME`, a WORD and never an assignment.
  return last === WORD && (before === 'coproc' || before === 'function')
}

/** The tokens after which bash 5.3 reads `time` as reserved: time_command_acceptable, parse.y 3285-3337. */
const TIME_ACCEPTABLE = new Set<Token>([
  ...['&&', '||', '&', 'while', 'do', 'until', 'if', 'then', 'elif', 'else', '{', '(', ')', '!'],
  ...['time', TIMEOPT, TIMEIGN],
])

function timeCommandAcceptable(last: Token, before: Token): boolean {
  // Token 0, `;` and a newline, unless they follow a `|`.
  if (last === undefined || last === ';' || last === '\n') return before !== '|'
  return TIME_ACCEPTABLE.has(last)
}

// bash's assignment(): a name, an optional subscript, then `=` or `+=`, all before any quote.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

/** The reserved words after whose next word an `in` is reserved, and for `for` and `select` a `do`. */
type Header = 'case' | 'for' | 'select'
const isHeader = (token: string | undefined): token is Header =>
  token === 'case' || token === 'for' || token === 'select'

// A `{` or `}` before one of these, or at the end, is a word of its own; bash closes a funsub at its `}` even without one.
const METACHAR = /[ \t\n;&|()<>]/

function bracedRisk(src: string, start: number, text: string): ExpansionRisk | undefined {
  if (UNREADABLE_BRACED.test(text)) return 'unreadable'
  const close = nestedClose(src, start)
  if (close < 0 || !SAME_WORD.test(src.slice(start + text.length, close + 1))) return 'unreadable'
  return PLAIN_BRACED.test(text) ? undefined : 'operator'
}

// A glob span that holds a substitution, a blank or an operator, which the shell may run as commands.
const SPAN_RUNS = /[\s;&]|\$\(|`|[<>]\(/
const BLANK = new Set([' ', '\t', '\n', ';', undefined])
// gh fills these in a `gh api` path itself; no shell expands a brace group that has no comma.
const GH_PLACEHOLDERS = ['{owner}', '{repo}', '{branch}']
// In a heredoc with an unquoted delimiter the shell expands these and joins a line ending in a backslash.
const HEREDOC_LIVE = /[$`\\]/
// bash 3.2 joins a line ending in a backslash in a heredoc inside `$(...)`, even under a quoted delimiter.
const JOINED = /\\(?:\n|$)/

/** The shell rewrites backslashes inside backticks before it parses them, so such a command is read as unsure. */
const blur = (cmd: SimpleCommand): void => {
  cmd.marked = cmd.marked.map((word, i) => (i === 0 ? word : LIVE + word))
  cmd.splits = cmd.marked
  cmd.stdinLive = true
}

const ANSI_C: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
}
const ANSI_C_CODE = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/

/** The `$'...'` escape whose backslash is at `src[at]`; `live` when the splitter cannot decode it, as with `\cX`. */
export function ansiCEscape(src: string, at: number): { text: string; width: number; live: boolean } {
  const next = src[at + 1] ?? ''
  const named = ANSI_C[next]
  if (named !== undefined) return { text: named, width: 2, live: false }
  const code = ANSI_C_CODE.exec(src.slice(at + 1))
  const octal = code?.[4]
  const point = code ? parseInt(octal ?? code[1] ?? code[2] ?? code[3] ?? '', octal ? 8 : 16) : -1
  // NUL ends the word in bash, and 1 is HOLE, so neither decodes.
  if (code === null || point < 2 || point > 0x10ffff) return { text: next, width: 2, live: true }
  return { text: String.fromCodePoint(point), width: code[0].length + 1, live: false }
}

class ShellLexer {
  pos: number
  private readonly out: SimpleCommand[] = []
  private cur: SimpleCommand
  private last: SimpleCommand | undefined
  private joiner = ''
  private word: string | null = null
  private marked = ''
  private splitting = false
  private quoted = false
  private pending: Pending | null = null
  /** Output redirects of a command with no words, which the next command inherits. */
  private carried: string[] = []
  private heredocs: Heredoc[] = []
  private depth = 0
  private closed = false
  /** Open `case` statements, and whether a pattern, whose `)` ends no group, comes next. */
  private caseDepth = 0
  private patternNext = false
  /** Where the first span the splitter cannot settle opens; see `mixesParenAndGuarded`. */
  mark: Mark | undefined
  /** Reading a funsub body, which a `}` in command position outside any `{ }` group closes. */
  closesOnBrace = false
  private braceDepth = 0
  private braceClosed = false
  /** What each open `(` starts: only in a subshell can `{` and `}` still be reserved words. */
  private parens: ParenKind[] = []
  /*
   * The parser state below is set token by token, as bash keeps it, and every structural decision
   * (a group's braces, a case's patterns, `[[ ]]`, what a `(` opens) reads it. Nothing is inferred
   * from the words of the current command, since a quoted `"if"` looks like `if` there.
   */
  /** A command may start at the next token, so a `(` there opens a subshell or arithmetic. */
  private atStart = true
  /**
   * bash's reserved_word_acceptable for the last token read, the one place a `{` or `}` is decided:
   * `reservedWordAcceptable` of the last two tokens, bar a `(` or `)` that is no subshell's, which bash
   * reads as part of a word or arithmetic. A redirect leaves it.
   */
  private reservedOk = true
  /** `reservedOk` when the current word began, so whether the word itself may be reserved. */
  private wordStartOk = true
  /** The current word began where a function name may stand: at a command start or after `function`. */
  private wordStartNames = true
  /** bash's last_read_token and token_before_that. */
  private lastToken: Token
  private beforeLast: Token
  /** Where in the current word its first quote or escape began, so whether it can be an assignment. */
  private quoteStart = Infinity
  /** The last token was a word that is not reserved, so a `}x` after it is a plain argument. */
  private lastPlain = false
  /** The last token was an unquoted word that may name a function, as `f` in `f ()`. */
  private named = false
  /** The header whose name or subject was the last word, so an `in` (or `do`) next is reserved. */
  private expectIn: Header | undefined
  /** Inside `[[ ]]`, where neither an operator nor a newline starts a command. */
  private testOpen = false

  constructor(
    private readonly src: string,
    start = 0,
    private readonly nested = false,
    private readonly budget: Budget = { forks: MAX_FORKS, expansion: undefined },
    private arith?: Arith,
  ) {
    this.pos = start
    this.cur = this.newCommand()
  }

  get expansion(): ExpansionRisk | undefined {
    return this.budget.expansion
  }

  private newCommand(): SimpleCommand {
    const nested = this.nested || this.depth !== 0
    const unsure = { stdinLive: false, backslash: false }
    return {
      words: [],
      marked: [],
      splits: [],
      substitutions: [],
      writes: [],
      ...unsure,
      before: '',
      after: '',
      nested,
      arith: this.inArith(),
      arithBodies: this.inArith() ? [this.arith?.text ?? ''] : [],
    }
  }

  run(): SimpleCommand[] {
    while (this.pos < this.src.length && !this.closed) this.step()
    this.endCommand()
    return this.out
  }

  private step(): void {
    const c = this.src[this.pos] as string
    if (c === '\\' && this.src[this.pos + 1] === '\n') return void (this.pos += 2)
    if (this.braceWord(c)) return
    if (c === ' ' || c === '\t') return this.skip(() => this.endWord())
    if (c === '\n') return this.newline()
    if (c === '(' || c === ')') return this.paren(c)
    // bash's `&>` and `&>>` send both streams to a file; they do not end the command.
    if (c === '&' && this.peek(this.pos + 1) === '>') return this.redirect()
    if (OPERATORS.has(c)) return this.operator(c)
    if (c === '#' && this.word === null) return this.skipComment()
    if (c === '<' || c === '>') return this.redirect()
    this.wordPart(c)
  }

  /**
   * In a funsub, counts `{ }` groups and closes at the `}` that ends none. A brace is reserved exactly
   * when `reservedOk` is set, outside `[[ ]]`, arithmetic and arrays. A `{` or `}` word anywhere else
   * makes the line unreadable, unless it is a plain argument such as `}x` after an ordinary word.
   */
  private braceWord(c: string): boolean {
    // After a redirect operator bash reads a `{` or `}` as the file name, never as a reserved word.
    if (!this.closesOnBrace || this.word !== null || this.patternNext || this.pending !== null) return false
    if (c === '{') this.openBrace()
    return c === '}' && this.closeBrace()
  }

  private openBrace(): void {
    const next = this.peek(this.pos + 1)
    if (next !== undefined && !METACHAR.test(next)) return
    if (this.braceReserved()) this.braceDepth++
    else this.budget.expansion = 'unreadable'
  }

  /**
   * bash closes at a reserved `}` even with no blank after it (`}x`). A `}` word that is neither reserved
   * and alone nor a plain argument after ordinary words is unreadable.
   */
  private closeBrace(): boolean {
    const reserved = this.braceReserved()
    if (reserved && this.braceDepth === 0) {
      this.endCommand()
      this.closed = this.braceClosed = true
      return true
    }
    const next = this.peek(this.pos + 1)
    const alone = next === undefined || METACHAR.test(next)
    if (reserved && alone) this.braceDepth--
    else if (reserved || alone || !this.plainArgument()) this.budget.expansion = 'unreadable'
    return false
  }

  private braceReserved(): boolean {
    return this.reservedOk && !this.testOpen && !this.inText()
  }

  /**
   * A `}x` that is not reserved is an argument after a plain word, or after `[[` inside `[[ ]]`, where
   * bash reads every word as text. Fails closed after anything else: an operator, a newline, a `(` or `)`,
   * or a reserved word such as `case` that a name follows.
   */
  private plainArgument(): boolean {
    return this.lastPlain || (this.testOpen && this.lastToken === '[[')
  }

  /** Inside `(( ))`, an array or another `(` that is no subshell, where bash reads a brace as text. */
  private inText(): boolean {
    return this.parens.some(kind => kind === 'text' || kind === 'arith')
  }

  private unjoin(at: number): number {
    return unjoinAt(this.src, at)
  }

  /** The character at `at` as bash reads it; every lookahead that decides a token goes through here. */
  private peek(at: number): string | undefined {
    return this.src[this.unjoin(at)]
  }

  /** The `n` characters from the cursor as bash reads them. */
  private ahead(n: number): string {
    let text = ''
    for (let at = this.unjoin(this.pos); at < this.src.length && text.length < n; at = this.unjoin(at + 1))
      text += this.src[at]
    return text
  }

  /** Moves the cursor past `n` characters as bash reads them. */
  private advance(n: number): void {
    this.pos = this.after(n)
  }

  /** The index after the `n` characters from the cursor as bash reads them. */
  private after(n: number): number {
    return skipChars(this.src, this.pos, n)
  }

  /** A `(` at the cursor followed only by blanks and a `)`, as in `name()`. */
  private emptyParens(): boolean {
    let at = this.unjoin(this.pos + 1)
    while (/\s/.test(this.src[at] ?? '')) at = this.unjoin(at + 1)
    return this.src[at] === ')'
  }

  /** The `)` closing arithmetic whose first `)` is at `end` is doubled, as bash reads it. */
  private doubled(end: number): boolean {
    return this.peek(end + 1) === ')'
  }

  /**
   * Records `token` as bash's last_read_token, so that `reservedOk` is reserved_word_acceptable of it,
   * or `ok` for a parenthesis bash does not read as a token of its own. A word that is not reserved
   * then sets `lastPlain` and `named` itself.
   */
  private accept(token: Token, ok = reservedWordAcceptable(token, this.lastToken)): void {
    this.reservedOk = ok
    this.beforeLast = this.lastToken
    this.lastToken = token
    this.lastPlain = this.named = false
  }

  /** Classifies a word as bash's parser would, the only place a word changes the parser state. */
  private afterWord(word: string, quoteStart: number): void {
    const quoted = quoteStart !== Infinity
    const before = this.lastToken
    const header = this.expectIn
    this.expectIn = undefined
    if (!quoted && this.reservedWord(word, header)) return this.takeReserved(word, header)
    const named = !quoted && this.wordStartNames && !word.includes('=')
    const token = this.wordToken(word, quoted, quoteStart)
    this.atStart = token === TIMEOPT || token === TIMEIGN
    this.accept(token)
    this.lastPlain = true
    this.named = named
    if (isHeader(before)) this.expectIn = before
  }

  /** The token bash's read_token_word gives a word that is not reserved: parse.y 3471-3481 and 5784-5847. */
  private wordToken(word: string, quoted: boolean, quoteStart: number): Token {
    const last = this.lastToken
    if (!quoted && word === '-p' && last === 'time') return TIMEOPT
    if (!quoted && word === '--' && (last === 'time' || last === TIMEOPT)) return TIMEIGN
    const name = ASSIGNMENT.exec(word)?.[0]
    const assigns = name !== undefined && name.length <= quoteStart
    return assigns && this.assignmentAcceptable() ? ASSIGNMENT_WORD : WORD
  }

  /** bash's assignment_acceptable and command_token_position, parse.y 3154-3164. */
  private assignmentAcceptable(): boolean {
    if (this.patternNext) return false
    return this.lastToken === ASSIGNMENT_WORD || (!CASE_ENDS.has(this.lastToken) && this.wordStartOk)
  }

  /**
   * CHECK_FOR_RESERVED_WORD and special_case_tokens, parse.y 3166-3209 and 3365-3489: only `]]` is
   * reserved inside `[[ ]]`, only `esac` where a case pattern is due, `time` only where
   * time_command_acceptable allows, and an `in` (or a `do` after `for` or `select`) after a header's name
   * even where no reserved word may be.
   */
  private reservedWord(word: string, header: Header | undefined): boolean {
    if (this.testOpen) return word === ']]'
    if (header !== undefined && (word === 'in' || (word === 'do' && header !== 'case'))) return true
    if (this.patternNext) return word === 'esac' && this.patternEsac()
    if (word === 'time' && !timeCommandAcceptable(this.lastToken, this.beforeLast)) return false
    return this.wordStartOk && RESERVED.has(word)
  }

  /** `case w in esac` ends at once; after a pattern's `|` or `(` an `esac` is a pattern (Posix rule 4). */
  private patternEsac(): boolean {
    const last = this.lastToken
    return (this.wordStartOk || last === 'in') && last !== '|' && last !== '('
  }

  /** `[[` and `]]` open and close a test; a case's `in` and `esac` open and close its patterns. */
  private takeReserved(word: string, header: Header | undefined): void {
    if (word === '[[' || word === ']]') this.testOpen = word === '[['
    else if (word === 'in' && header === 'case') this.caseDepth++
    else if (word === 'esac' && this.caseDepth > 0) this.caseDepth--
    if (word === 'in' || word === 'esac') this.patternNext = word === 'in' && header === 'case'
    this.atStart = RESERVED.get(word) ?? false
    this.accept(word)
  }

  private skip(then: () => void): void {
    then()
    this.pos++
  }

  private newline(): void {
    this.endCommand()
    this.atStart = !this.testOpen
    this.accept('\n')
    this.join('\n')
    this.pos++
    this.readHeredocs()
  }

  private operator(c: string): void {
    const ahead = this.ahead(3)
    const op = OPERATOR_TOKENS.find(token => ahead.startsWith(token)) ?? c
    if (CASE_ENDS.has(op) && this.caseDepth > 0) this.patternNext = true
    this.endCommand()
    this.expectIn = undefined
    this.atStart = !this.testOpen
    this.accept(op)
    // A command joined by `|&`, `;;` or `;&` records its first character, `|` or `;`.
    this.join(op === '&&' || op === '||' ? op : c)
    this.advance(op.length)
  }

  /** A newline after `&&`, `||` or `|` continues the list, so it never replaces that operator. */
  private join(op: string): void {
    if (this.joiner === '') this.joiner = op
    if (this.last !== undefined && this.last.after === '') this.last.after = op
  }

  /** `name(`, `name ()` and `<(`: a glob qualifier, a function and a process substitution, none modelled. */
  private paren(c: string): void {
    if (this.patternNext && this.word === null && c === '(') return this.skip(() => this.accept('('))
    if (this.patternNext && c === ')') this.endWord()
    if (this.patternNext && c === ')') return this.endPattern()
    if (c === '(' && this.globGroup()) return
    const fed = c === '(' && this.word === null && this.pending !== null
    const opensCommand = this.word === null && !fed
    const kind = this.parenKind(opensCommand)
    if (fed) this.pending = null
    if (fed || (c === '(' && this.word !== null)) this.append('', true)
    this.endWord()
    const defined = this.cur.marked.length - 1
    if (defined >= 0 && this.emptyParens()) this.cur.marked[defined] += LIVE
    this.endCommand()
    if (c === ')' && this.nested && this.depth === 0) return void (this.closed = true)
    if (c === '(') this.parens.push(kind)
    const closed = c === ')' ? this.parens.pop() : undefined
    this.expectIn = undefined
    this.atStart = c === '(' ? kind === 'subshell' : closed === 'function' || closed === 'header'
    this.acceptParen(c, c === '(' ? kind : closed)
    this.depth += c === '(' ? 1 : -1
    this.trackArith(c, opensCommand)
    this.pos++
    this.cur = this.newCommand()
  }

  /**
   * The token a `(` or `)` leaves. Only a subshell's `(` lets a reserved word follow; an array's `( )`
   * is part of its assignment word, and arithmetic's `((`, `))` and the `))` of `for (( ))` are tokens
   * of their own, after which bash opens a `{` (parse.y 3455-3463).
   */
  private acceptParen(c: string, kind: ParenKind | undefined): void {
    if (c === '(') return this.accept('(', kind === 'subshell')
    if (kind === 'text') return this.accept(ASSIGNMENT_WORD, false)
    if (kind === 'arith') return this.accept(ARITH_CMD)
    this.accept(kind === 'header' ? ARITH_FOR_EXPRS : ')', true)
  }

  /** A `(` at a command start that is not `((`, `[[` or arithmetic opens a subshell; `name()` is a function's. */
  private parenKind(opensCommand: boolean): ParenKind {
    if (this.testOpen) return 'text'
    if (this.emptyParens()) return this.defines() ? 'function' : 'text'
    if (!opensCommand) return 'text'
    const doubled = this.peek(this.pos + 1) === '('
    // `for ((;;))` is followed by a `{ }` or `do` body, so its close starts a command.
    if (doubled && this.lastToken === 'for') return 'header'
    if (!this.atStart || this.inArith()) return 'text'
    return doubled ? 'arith' : 'subshell'
  }

  /** `name()` or `function name()`, whose name is the word before the `()` or the one it ends; `a=()` is an array. */
  private defines(): boolean {
    const word = this.word
    if (word === null) return this.named
    return !this.quoted && this.wordStartNames && !word.includes('=')
  }

  private endPattern(): void {
    this.endCommand()
    this.atStart = true
    this.accept(')')
    this.patternNext = false
    this.pos++
  }

  private inArith(): boolean {
    return this.arith !== undefined && this.depth >= this.arith.depth
  }

  /** A `((` at command position is arithmetic when bash finds its `))`; `((a) )` and `((a)|b)` are subshells. */
  private trackArith(c: string, opensCommand: boolean): void {
    if (c === ')' && !this.inArith()) this.arith = undefined
    if (c !== '(' || !opensCommand || this.arith !== undefined || this.peek(this.pos + 1) !== '(') return
    const span = this.budget.probe ? undefined : arithSpan(this.src, this.after(2), ')')
    if (span && this.doubled(span.end)) this.arith = { depth: this.depth + 1, text: span.text }
  }

  /** Notes the body of a `$[ ]` the shell evaluates as arithmetic; the lexer still reads what is inside it. */
  private noteBracket(): void {
    const span = this.budget.probe ? undefined : arithSpan(this.src, this.after(2), ']')
    if (span !== undefined) this.cur.arithBodies.push(span.text)
  }

  /**
   * zsh reads `g(i|x)t`, `*.ts(.)` and an argument `(-c|push)` as one glob word (TP-721, CC-728). In
   * argument position every balanced span, with its nesting, quotes and escapes, is one live word, so
   * no group can hide an option from the git rules; a span with no close keeps its words visible
   * and marks only the `(` live. `name()` stays a function, `x=(` an array, and a `(` that opens a
   * subshell, a case pattern or a `[[ ]]` operand keeps the subshell reading.
   */
  private globGroup(): boolean {
    const word = this.word
    if (this.pending !== null || (word !== null && /[={]$/.test(word))) return false
    if (this.emptyParens() || (word === null && this.opensCommand())) return false
    const end = this.groupEnd()
    if (end < 0 || !PLAIN_GROUP.test(this.src.slice(this.pos, end))) this.unsettled()
    if (end < 0) {
      this.split('(')
      this.pos++
      return true
    }
    const span = this.src.slice(this.pos, end)
    if (SPAN_RUNS.test(span)) {
      this.substituted(span, new ShellLexer(span.slice(1, -1), 0, true, this.budget).run(), false)
    }
    this.split(span)
    this.pos = end
    this.readRestAsCommand()
    return true
  }

  /**
   * The shell may read the span as a subshell instead: after `coproc`, `repeat 1`, `for i`, `time -p`
   * and other words, the span's text holds commands and what follows it starts one. So both readings
   * are kept, and a prefix this splitter does not know cannot hide a command.
   */
  private readRestAsCommand(): void {
    if (this.budget.forks-- <= 0) return this.unsettled()
    const rest = new ShellLexer(this.src, this.pos, this.nested || this.depth !== 0, this.budget)
    this.out.push(...rest.run())
  }

  /** A span whose end or reading the splitter cannot be sure of: the commands after it are held to account. */
  private unsettled(): void {
    this.mark ??= { after: this.out.length, skip: this.cur }
  }

  /**
   * The `(` starts a command, a `[[` operand or follows another `(`, as in `((`: not an argument. A case
   * pattern's `(` never gets here.
   */
  private opensCommand(): boolean {
    if (this.atStart || this.testOpen || this.lastToken === '(') return true
    // `for ((i=0; i<3; i++))` is arithmetic, not a glob.
    return this.lastToken === 'for' && this.ahead(2) === '(('
  }

  /** The index after the `)` that closes the `(` at the cursor, or -1 when the span is unbalanced or crosses a line. */
  private groupEnd(): number {
    let depth = 0
    for (let i = this.pos; i < this.src.length; i++) {
      const c = this.src[i] as string
      if (c === '\n') return -1
      if (c === '\\') i++
      else if (c === '$' && this.peek(i + 1) === "'") i = this.closeAnsi(this.unjoin(i + 1))
      else if (c === "'" || c === '"') i = this.closeQuote(i, c)
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i + 1
      if (i < 0) return -1
    }
    return -1
  }

  /** The index of the quote closing the `$'` quote whose `'` is at `from`; a backslash escapes the next character. */
  private closeAnsi(from: number): number {
    for (let i = from + 1; i < this.src.length; i++) {
      if (this.src[i] === '\\') i++
      else if (this.src[i] === "'") return i
    }
    return -1
  }

  /** The index of the quote closing the one at `from`, or -1. */
  private closeQuote(from: number, quote: string): number {
    for (let i = from + 1; i < this.src.length; i++) {
      if (this.src[i] === '\\' && quote === '"') i++
      else if (this.src[i] === quote) return i
    }
    return -1
  }

  private skipComment(): void {
    const end = this.src.indexOf('\n', this.pos)
    this.pos = end < 0 ? this.src.length : end
  }

  private redirect(): void {
    const range = /^<\d*-\d*>/.exec(this.src.slice(this.pos).replaceAll('\\\n', ''))?.[0]
    if (range !== undefined) return this.globRange(range)
    // In `2&>f` the 2 is an argument, not a descriptor.
    const fd = this.src[this.pos] === '&' ? -1 : this.descriptor()
    const aside = fd > 0
    this.endWord()
    const ahead = this.ahead(3)
    if (ahead === '<<<') return this.expect(aside ? 'discard' : 'herestring', 3)
    if (ahead.startsWith('<<')) {
      const strip = ahead[2] === '-'
      return this.expect({ strip, aside }, strip ? 3 : 2)
    }
    // bash takes `0>&3` for a copy of descriptor 3 onto stdin, whatever the direction of the arrow.
    if (fd === 0 || (fd < 0 && ahead[0] === '<')) this.cur.stdinLive = true
    this.pending = WRITE_OPERATORS.has(this.redirectOperator()) ? 'write' : 'discard'
  }

  /** Reads the redirect operator at the cursor, such as `>`, `>>`, `>&`, `&>>` or `>|`. */
  private redirectOperator(): string {
    let op = this.peek(this.pos) ?? ''
    this.advance(1)
    for (let c = this.peek(this.pos); c !== undefined && '>&|'.includes(c); c = this.peek(this.pos)) {
      op += c
      this.advance(1)
    }
    return op
  }

  /** The number an unquoted digit word gives a redirect, such as the 3 of `3<<EOF`; -1 when there is none. */
  private descriptor(): number {
    if (this.word === null || this.quoteStart !== Infinity || !/^\d+$/.test(this.word)) return -1
    // zsh reads `12<f` as the word 12 and a redirect of stdin, where bash reads descriptor 12.
    if (this.word.length > 1 && this.src[this.pos] === '<') this.cur.stdinLive = true
    const fd = Number(this.word)
    this.word = null
    return fd
  }

  /** zsh matches `<1-9>` against file names, so it is a glob and not two redirects. */
  private globRange(range: string): void {
    this.advance(range.length)
    this.append(range, true)
  }

  private expect(pending: Pending, width: number): void {
    this.pending = pending
    this.advance(width)
  }

  private wordPart(c: string): void {
    const next = this.peek(this.pos + 1)
    this.quoted ||= c === "'" || c === '"' || c === '\\'
    // bash's parser sees `$'if'` quoted too, so it is neither a reserved word nor an assignment's name.
    if (this.quoted || (c === '$' && next === "'"))
      this.quoteStart = Math.min(this.quoteStart, this.word?.length ?? 0)
    if (c === "'") return this.append(this.until("'"))
    if (c === '"') return this.doubleQuoted()
    if (c === '$' && next === "'") return this.ansiC()
    if (c === '$' && next === '[') this.noteBracket()
    if (c === '$' && next === '(') return this.split(this.substitution(false))
    const fun = this.funsub(false)
    if (fun !== undefined) return this.split(fun)
    if (c === '$' && next === '{') return this.split(this.braced())
    if (c === '`') return this.split(this.backtick(false))
    if (c === '\\') {
      this.pos += 2
      return this.append(this.src[this.pos - 1] ?? '')
    }
    this.pos++
    const live = this.expands(c, next)
    this.splitting ||= live && (c === '$' || GLOB.includes(c))
    this.append(c, live)
  }

  /** Appends an unquoted expansion, which the shell splits into words. */
  private split(text: string): void {
    this.splitting = true
    this.append(text, true)
  }

  /** A `{` or `}` alone is a group, not a brace expansion; a leading `=` is zsh's command path. */
  private expands(c: string, next: string | undefined): boolean {
    const starts = this.word === null
    if ((c === '{' || c === '}') && starts && BLANK.has(next)) return false
    if (GH_PLACEHOLDERS.some(name => this.src.startsWith(name, this.pos - 1))) return false
    return c === '$' || GLOB.includes(c) || (starts && (c === '~' || c === '='))
  }

  private braced(): string {
    const text = this.bracedAt()
    this.pos += text.length
    return text
  }

  /** The `${...}` at the cursor, up to its first `}`, which is where an operator expansion stops being read right. */
  private bracedAt(): string {
    const end = this.src.indexOf('}', this.pos)
    const text = this.src.slice(this.pos, end < 0 ? this.src.length : end + 1)
    const risk = bracedRisk(this.src, this.pos, text)
    if (risk === 'unreadable') this.budget.expansion = risk
    else if (risk !== undefined) this.budget.expansion ??= risk
    return text
  }

  private append(text: string, live = false): void {
    if (this.word === null) this.startWord()
    this.marked = (this.word === null ? '' : this.marked) + (live ? LIVE : '') + text
    this.word = (this.word ?? '') + text
  }

  private startWord(): void {
    this.wordStartOk = this.reservedOk
    this.wordStartNames = this.atStart || this.lastToken === 'function'
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
      const next = this.peek(this.pos + 1) ?? ''
      const escaped = this.src[this.pos + 1] ?? ''
      if (c === '$' && next === '[') this.noteBracket()
      const fun = this.funsub(true)
      if (fun !== undefined) this.append(fun, true)
      else if (c === '$' && next === '(') this.append(this.substitution(true), true)
      else if (c === '`') this.append(this.backtick(true), true)
      else if (c === '$' && next === '{') {
        this.bracedAt()
        this.append(c, true)
        this.pos++
      } else if (c === '\\' && '$`"\\\n'.includes(escaped)) {
        this.append(escaped === '\n' ? '' : escaped)
        this.pos += 2
      } else {
        this.append(c, c === '$')
        this.pos++
      }
    }
    this.pos++
  }

  /** Decodes `\x67`, `\147` and the rest, so `$'\x67it'` reads as git (TP-721); an escape it cannot decode stays LIVE. */
  private ansiC(): void {
    this.append('')
    this.advance(2)
    while (this.pos < this.src.length && this.src[this.pos] !== "'") {
      const c = this.src[this.pos] as string
      const escape = c === '\\' ? ansiCEscape(this.src, this.pos) : { text: c, width: 1, live: false }
      this.append(escape.text, escape.live)
      this.pos += escape.width
    }
    this.pos++
  }

  /** Parses the inner commands too, so `$(git push --no-verify)` is seen; the word keeps the raw text. */
  private substitution(quoted: boolean): string {
    const start = this.pos
    const arith = this.substitutedArith(start)
    if (arith !== undefined) this.cur.arithBodies.push(arith.text)
    const inner = new ShellLexer(this.src, this.after(2), true, this.budget, arith)
    const commands = inner.run()
    this.pos = Math.min(inner.pos + 1, this.src.length)
    if (inner.mark !== undefined) this.unsettled()
    return this.substituted(this.src.slice(start, this.pos), commands, quoted)
  }

  /** Reads the body of a funsub at the cursor as commands; with no `}` where bash closes it, the line is unreadable. */
  private funsub(quoted: boolean): string | undefined {
    const body = funsubBody(this.src, this.pos)
    if (body === undefined) return undefined
    const start = this.pos
    const inner = new ShellLexer(this.src, body, true, this.budget)
    inner.closesOnBrace = true
    const commands = inner.run()
    if (!inner.braceClosed) this.budget.expansion = 'unreadable'
    this.pos = Math.min(inner.pos + 1, this.src.length)
    if (inner.mark !== undefined) this.unsettled()
    return this.substituted(this.src.slice(start, this.pos), commands, quoted)
  }

  /** A `$((` is arithmetic when bash finds its `))`; `$((a) )` is a substitution of a subshell. */
  private substitutedArith(start: number): Arith | undefined {
    if (this.budget.probe || this.ahead(3) !== '$((') return undefined
    const span = arithSpan(this.src, skipChars(this.src, start, 3), ')')
    return span && this.doubled(span.end) ? { depth: 1, text: span.text } : undefined
  }

  private backtick(quoted: boolean): string {
    const start = this.pos
    const inner = this.until('`')
    const lexer = new ShellLexer(inner, 0, true, this.budget)
    const commands = lexer.run()
    if (lexer.mark !== undefined) this.unsettled()
    if (inner.includes('\\')) commands.forEach(blur)
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
    const quoteStart = this.quoteStart
    const splitting = this.splitting
    this.splitting = false
    this.word = null
    this.quoted = false
    this.quoteStart = Infinity
    const pending = this.pending
    this.pending = null
    if (pending === null) {
      this.cur.words.push(word)
      this.cur.marked.push(this.marked)
      if (splitting) this.cur.splits.push(this.marked)
      this.afterWord(word, quoteStart)
    } else if (pending === 'write') this.cur.writes.push(this.marked)
    else if (pending === 'herestring') this.feed(this.cur, word, this.marked.includes(LIVE))
    else if (pending !== 'discard') this.heredocs.push({ delim: word, ...pending, quoted, target: this.cur })
  }

  /** zsh feeds a command every heredoc and here-string it is given and bash only the last, so a second one is unsure. */
  private feed(target: SimpleCommand, text: string, live: boolean): void {
    target.stdinLive ||= live || target.stdin !== undefined
    target.stdin = (target.stdin ?? '') + text
  }

  private endCommand(): void {
    this.endWord()
    if (this.cur.words.length === 0) this.carried.push(...this.cur.writes)
    else {
      this.cur.writes.unshift(...this.carried.splice(0))
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
      if (doc.aside) continue
      const backslash = doc.quoted ? this.nested && JOINED.test(body) : body.includes('\\')
      doc.target.backslash ||= backslash
      this.feed(doc.target, body, doc.quoted ? backslash : HEREDOC_LIVE.test(body))
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

/** The index after the `)` that ends the `$(` whose body starts at `from`, found by the lexer; -1 if it never ends. */
function substitutionEnd(src: string, from: number): number {
  const probe = new ShellLexer(src, from, true, { forks: MAX_FORKS, expansion: undefined, probe: true })
  probe.run()
  return src[probe.pos] === ')' ? probe.pos + 1 : -1
}

/** Where arithmetic reading goes on from, and the text it keeps for the span it passed. */
interface Step {
  next: number
  text: string
}

/** The step past the quote, backtick or `${...}` that opens at `at`. */
function skipQuoted(src: string, at: number): Step | undefined {
  const c = src[at]
  if (c === '"') {
    const inner = arithSpan(src, at + 1, '"')
    return inner && { next: inner.end + 1, text: `"${inner.text}"` }
  }
  const close = c === '$' ? nestedClose(src, at) : src.indexOf(c === '`' ? '`' : "'", at + 1)
  if (close < 0) return undefined
  return { next: close + 1, text: c === '`' ? ' ' : src.slice(at, close + 1) }
}

/**
 * Where the `closer` that ends arithmetic opened before `from` is, read as bash does: quotes, escapes,
 * `${...}`, backticks and `$(...)` (by the lexer, so a `)` in a quote or a case pattern does not end it)
 * are passed over, and each substitution is blanked in the text, since it is checked as a command.
 */
function arithSpan(src: string, from: number, closer: string): { end: number; text: string } | undefined {
  const opener = { ')': '(', ']': '[' }[closer]
  let depth = 0
  let text = ''
  for (let i = unjoinAt(src, from); i < src.length; i = unjoinAt(src, i)) {
    const c = src[i] as string
    const next = src[unjoinAt(src, i + 1)]
    if (c === closer && depth-- === 0) return { end: i, text }
    if (c === opener) depth++
    const skip = skipIn(src, i, c, next, closer === '"')
    if (skip === undefined) return undefined
    text += skip.text
    i = skip.next
  }
  return undefined
}

/** The step from `src[at]` inside arithmetic or, when `quoted`, inside its double quotes. */
function skipIn(
  src: string,
  at: number,
  c: string,
  next: string | undefined,
  quoted: boolean,
): Step | undefined {
  if (c === '\\') return { next: at + 2, text: src.slice(at, at + 2) }
  if (c === '$' && next === '(') {
    const end = substitutionEnd(src, skipChars(src, at, 2))
    return end < 0 ? undefined : { next: end, text: ' ' }
  }
  if ((c === '$' && next === '{') || c === '`' || (!quoted && (c === '"' || c === "'")))
    return skipQuoted(src, at)
  return { next: at + 1, text: c }
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

/**
 * The worst unquoted or double-quoted `${...}` in `src` that is not `${NAME}` or `${1}`. The splitter
 * ends one at its first `}`, so `${X:-'${Y}'}` opens a quote it never closes and hides any command
 * after it, even one spelt `g''h`, and zsh's `${(e)...}` runs the text it expands (CC-718).
 */
export function expansionRisk(src: string): ExpansionRisk | undefined {
  const lexer = new ShellLexer(unmark(src))
  lexer.run()
  return lexer.expansion
}

const GUARDED_COMMAND = /(?:^|\/)(?:git|gh)$/

/** A command word the shell may turn into git or gh, or that is one, among the words a wrapper leaves before it. */
const namesGuarded = (cmd: SimpleCommand): boolean =>
  cmd.words.slice(0, 4).some(word => GUARDED_COMMAND.test(word)) || (cmd.marked[0]?.includes(LIVE) ?? false)

/**
 * Whether a span the splitter cannot settle (a `(` outside command position that holds a quote, an
 * escape, a blank or an operator, has no close, or comes in too many groups) is followed by a command
 * that is, or may be, git or gh. Such a line is denied and not guessed at (CC-728). The test is on parsed
 * words, after quotes, escapes and continuations are read, never on the raw text.
 */
export function mixesParenAndGuarded(src: string): boolean {
  const lexer = new ShellLexer(unmark(src))
  const commands = lexer.run()
  const { mark } = lexer
  return mark !== undefined && commands.slice(mark.after).some(cmd => cmd !== mark.skip && namesGuarded(cmd))
}
