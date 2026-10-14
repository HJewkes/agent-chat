/**
 * Reads the argv of two programs that run another command (CC-1223): `find`'s action clauses
 * (`-exec`, `-execdir`, `-ok`, `-okdir`) and GNU `parallel`'s options, command and inputs. Pure:
 * the words come in marked (LIVE before what the shell expands) and the caller decides what to
 * check. An unquoted `{}` lexes to LIVE + `{}` but the shell leaves it alone, so it reads as plain.
 * Option tables are from GNU findutils 4.10 and GNU parallel's `options_hash`.
 */

import { LIVE, unmark } from './shell-words.js'

const BRACE_PAIR = LIVE + '{}'
const plain = (word: string): string => word.replaceAll(BRACE_PAIR, '{}')
const hidden = (word: string): boolean => plain(word).includes(LIVE)

export interface FindClause {
  action: '-exec' | '-execdir' | '-ok' | '-okdir'
  /** Index in `marked` of the clause's first command word. */
  at: number
  words: string[]
  /**
   * `+` only after `{}` in an `-exec` or `-execdir` clause, since find reads `+` as a plain word for
   * `-ok`/`-okdir`. `undefined` when the words ran out first: find refuses that, but the words are
   * read anyway.
   */
  terminator: ';' | '+' | undefined
}

export interface FindCall {
  clauses: FindClause[]
  /** The first unreadable word outside a clause; it may expand to `-exec`, so the scan stops there. */
  hiddenAt?: number
}

const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** Tests and options whose next word is a value, so a value spelled `-exec` starts no clause. */
const FIND_ONE_VALUE: ReadonlySet<string> = new Set(
  [
    'amin anewer atime cmin cnewer context ctime fls fprint fprint0 fstype gid group ilname iname',
    'inum ipath iregex iwholename links lname maxdepth mindepth mmin mtime name newer path perm',
    'printf regex regextype samefile size type uid used user wholename xtype files0-from D',
  ]
    .join(' ')
    .split(' ')
    .map(name => '-' + name),
)

function findValueCount(word: string): number {
  if (word === '-fprintf') return 2
  return FIND_ONE_VALUE.has(word) || /^-newer[aBcmt][aBcmt]$/.test(word) ? 1 : 0
}

/** The clause starting after its action word at `from`, and the index just past its terminator. */
function readClause(
  marked: readonly string[],
  action: FindClause['action'],
  from: number,
): [FindClause, number] {
  for (let i = from; i < marked.length; i++) {
    const word = marked[i]
    const batches = action === '-exec' || action === '-execdir'
    const ends = word === ';' || (batches && word === '+' && unmark(marked[i - 1] ?? '') === '{}' && i > from)
    if (ends) return [{ action, at: from, words: marked.slice(from, i), terminator: word }, i + 1]
  }
  return [{ action, at: from, words: marked.slice(from), terminator: undefined }, marked.length]
}

/**
 * Every action clause in `marked` (find's words after its name), from index `from`. Clause words come
 * back as they are, and the caller has two duties. A clause word it cannot read may expand to `;` and
 * end the clause early, so the words after it run as find's own, which may be another `-exec`. So
 * the caller must deny any such word. And find passes each clause word as one argv entry, so a
 * single quoted word such as `'git push'` is a program name with a space in it, not a command line.
 * Only `sh -c` and the like re-parse a word as shell.
 */
export function findClauses(marked: readonly string[], from = 0): FindCall {
  const clauses: FindClause[] = []
  let i = from
  while (i < marked.length) {
    const word = marked[i] ?? ''
    if (hidden(word)) return { clauses, hiddenAt: i }
    if (FIND_ACTIONS.has(word)) {
      const [clause, next] = readClause(marked, word as FindClause['action'], i + 1)
      clauses.push(clause)
      i = next
      continue
    }
    const values = marked.slice(i + 1, i + 1 + findValueCount(word))
    const hiddenValue = values.findIndex(hidden)
    if (hiddenValue >= 0) return { clauses, hiddenAt: i + 1 + hiddenValue }
    i += 1 + values.length
  }
  return { clauses }
}

/**
 * How the guard must read an allowlisted option's value. GNU parallel runs some numeric values
 * through perl `eval` to apply units (`--memfree`, `--delay`, `--timeout`), so a `numeric` value
 * must be a literal matching its option's grammar in `NUMERIC_GRAMMAR`. `evaluated` values are
 * expanded with replacement strings and `{= perl =}`, `replace` values become replacement strings,
 * `separator` values split the inputs, and `argFile` names a file of inputs the guard does not read.
 * Every kind but `numeric` is accepted only as a literal read in full, without `{=`, and only once.
 */
type ValueKind = 'numeric' | 'evaluated' | 'replace' | 'separator' | 'argFile'

const NUMBER = String.raw`\d+(?:\.\d+)?`

/** One strict shape per numeric option: digits, an optional decimal part and at most one unit. */
const NUMERIC_GRAMMAR: ReadonlyMap<string, RegExp> = new Map([
  ['jobs', new RegExp(`^[+-]?${NUMBER}%?$`)],
  ['max-procs', new RegExp(`^[+-]?${NUMBER}%?$`)],
  ['halt', /^(?:-?\d+|never|(?:now|soon),(?:fail|success|done)=\d+%?)$/],
  ['timeout', new RegExp(`^${NUMBER}[smhdw%]?$`)],
  ['delay', new RegExp(`^${NUMBER}[smhdw]?$`)],
  ['memfree', new RegExp(`^${NUMBER}[kmgtpezy]?$`, 'i')],
  ['load', new RegExp(`^${NUMBER}%?$`)],
  ['retries', /^\d+$/],
  ['nice', /^-?\d+$/],
])

/** Options whose value perl opens as a path, where `|`, `<` or `>` would make it run a command. */
const PATH_OPTIONS: ReadonlySet<string> = new Set(['arg-file', 'joblog', 'results'])

/**
 * An allowlist: only options whose whole effect `ParallelCall` carries or which leave the command
 * and its inputs alone. Every other option is refused. That includes the ones that regroup inputs
 * into one command (`-X`, `-m`, `--xargs`, `-n`, `-N`, `-L`, `--max-*`, `-C`/`--colsep`), drop or
 * reshape inputs (`-E`, `-d`, `-0`, `--header`, `--pipe`), name a command of their own
 * (`-S`/`--sshlogin`, `--ssh`), or splice text into perl (`--plus`, `--rpl`). Long names are without
 * the leading `--`; one-letter names are short options.
 */
const PARALLEL_VALUE: ReadonlyMap<string, ValueKind> = new Map([
  ...[...NUMERIC_GRAMMAR.keys()].map(name => [name, 'numeric'] as const),
  ...['tagstring', 'results', 'joblog'].map(name => [name, 'evaluated'] as const),
  ...['I', 'extensionreplace', 'basenamereplace', 'dirnamereplace', 'seqreplace', 'slotreplace'].map(
    name => [name, 'replace'] as const,
  ),
  ['arg-sep', 'separator'],
  ['arg-file-sep', 'separator'],
  ['arg-file', 'argFile'],
])

const PARALLEL_LONG_FLAG: ReadonlySet<string> = new Set(
  [
    'keep-order quote ungroup verbose group line-buffer lb tag dry-run bar progress eta will-cite',
    'shuf no-notice',
  ]
    .join(' ')
    .split(' '),
)

const PARALLEL_SHORT_FLAG = new Set('kquvt')

/** Short options that take a value, by the long name they stand for. */
const SHORT_VALUE: ReadonlyMap<string, string> = new Map([
  ['a', 'arg-file'],
  ['I', 'I'],
  ['j', 'jobs'],
  ['P', 'max-procs'],
])

export type ParallelInputs = { kind: 'literal'; groups: string[][] } | { kind: 'unread' }

export interface ParallelCall {
  /** The command words, still marked; empty when parallel runs each input as a command. */
  command: string[]
  /** `-q`/`--quote`: each command word is shell-quoted rather than joined. */
  quote: boolean
  inputs: ParallelInputs
  /** Replacement strings set by `-I` and the `--*replace` options, beside the default `{}` family. */
  replaceStrings: string[]
}

interface ParallelOptions {
  /** The non-numeric value options already read: GNU keeps only the last of a repeated one. */
  seen: Set<string>
  quote: boolean
  argFile: boolean
  replaceStrings: string[]
  argSep: string
  argFileSep: string
}

/** One option and its value; `undefined` value means a flag. */
type Option = { name: string; value: string | undefined }

/** The options one word holds, and how many words they took; `null` when the guard cannot read them. */
type Read = [Option[], number] | null

/** One `--name[=value]` word. */
function readLong(word: string, next: string | undefined): Read {
  const eq = word.indexOf('=')
  const name = eq < 0 ? word.slice(2) : word.slice(2, eq)
  if (PARALLEL_LONG_FLAG.has(name) && eq < 0) return [[{ name, value: undefined }], 1]
  if (!PARALLEL_VALUE.has(name)) return null
  const value = eq < 0 ? next : word.slice(eq + 1)
  if (value === undefined) return null
  return [[{ name, value }], eq < 0 ? 2 : 1]
}

/** One `-xyz` cluster, which Getopt::Long's bundling reads letter by letter. */
function readCluster(word: string, next: string | undefined): Read {
  const options: Option[] = []
  for (let i = 1; i < word.length; i++) {
    const letter = word[i] ?? ''
    if (PARALLEL_SHORT_FLAG.has(letter)) {
      options.push({ name: letter, value: undefined })
      continue
    }
    const name = SHORT_VALUE.get(letter)
    if (name === undefined) return null
    const attached = word.slice(i + 1)
    const value = attached === '' ? next : attached
    if (value === undefined) return null
    options.push({ name, value })
    return [options, attached === '' ? 2 : 1]
  }
  return [options, 1]
}

/** GNU parallel runs the perl in a `{= … =}` string, in the command and in option values alike. */
const runsPerl = (word: string): boolean => unmark(word).includes('{=')

/** Whether `value` for option `name` of `kind` is one the guard read in full and that runs no perl. */
function valueIsSafe(name: string, kind: ValueKind, value: string): boolean {
  const read = unmark(plain(value))
  if (kind === 'numeric') return !value.includes(LIVE) && (NUMERIC_GRAMMAR.get(name)?.test(read) ?? false)
  if (runsPerl(value) || hidden(value) || read === '') return false
  if (PATH_OPTIONS.has(name) && /[|<>]/.test(read)) return false
  return kind !== 'separator' || SEPARATOR.test(read)
}

/**
 * A separator the shell never rewrites and Getopt never reads as an option: no braces, globs,
 * quotes, `$` or `^`, and no leading `-` or `+`. So a word spelling it reads the same to the guard and to parallel.
 */
const SEPARATOR = /^[A-Za-z0-9_:,.@%=][A-Za-z0-9_:,.@%+=]*$/

/**
 * Folds one read option into `opts`; false when the guard cannot account for it: an unclassified
 * option, a value it may not read, or a repeated non-numeric option. A separator off the `SEPARATOR`
 * grammar is refused, and so is one that clashes with the other or with a replacement string.
 */
function applyOption(opts: ParallelOptions, { name, value }: Option): boolean {
  if (value === undefined) {
    if (name === 'q' || name === 'quote') opts.quote = true
    return true
  }
  const kind = PARALLEL_VALUE.get(name)
  if (kind === undefined || !valueIsSafe(name, kind, value)) return false
  if (kind !== 'numeric' && opts.seen.has(name)) return false
  opts.seen.add(name)
  const read = unmark(plain(value))
  if (kind === 'argFile') opts.argFile = true
  if (kind === 'replace') opts.replaceStrings.push(read)
  if (name === 'arg-sep') opts.argSep = read
  if (name === 'arg-file-sep') opts.argFileSep = read
  return separatorsSound(opts)
}

/** The four separator spellings parallel matches, `:::`, `:::+`, `::::` and `::::+` by default. */
const separators = (opts: ParallelOptions): string[] => [
  opts.argSep,
  opts.argSep + '+',
  opts.argFileSep,
  opts.argFileSep + '+',
]

/**
 * Whether the separators can be told apart from each other and from a replacement string. A
 * separator spelled `{}` or `{.}` (or one equal to the other separator) is a word the guard would
 * read one way while parallel reads it the other, so it is refused.
 */
function separatorsSound(opts: ParallelOptions): boolean {
  const all = separators(opts)
  return new Set(all).size === all.length && !all.some(sep => holdsReplacement(sep, opts.replaceStrings))
}

/** The text parallel sees for `word`, or `undefined` when the shell may change it. */
const wordOf = (word: string): string | undefined => (hidden(word) ? undefined : unmark(plain(word)))

/** The options before the command and the index of the first word after them, or the unknown option's index. */
function readParallelOptions(
  marked: readonly string[],
  splits: readonly string[],
  from: number,
): [ParallelOptions, number] | number {
  const opts: ParallelOptions = {
    seen: new Set(),
    quote: false,
    argFile: false,
    replaceStrings: [],
    argSep: ':::',
    argFileSep: '::::',
  }
  let i = from
  while (i < marked.length) {
    const word = marked[i] ?? ''
    if (plain(word).startsWith(LIVE) || word.startsWith('+')) return i
    if (!word.startsWith('-') || word === '-' || isSeparator(opts, word)) return [opts, i]
    if ((word.split('=')[0] ?? '').includes(LIVE)) return i
    const read = word.startsWith('--') ? readLong(word, marked[i + 1]) : readCluster(word, marked[i + 1])
    if (read === null || !read[0].every(option => applyOption(opts, option))) return i
    if (marked.slice(i, i + read[1]).some(taken => splits.includes(taken))) return i
    i += read[1]
  }
  return [opts, i]
}

/** Whether `word` is a separator once the shell removes its quotes; an unreadable word never is. */
const isSeparator = (opts: ParallelOptions, word: string): boolean =>
  separators(opts).includes(wordOf(word) ?? LIVE)

const isFileSeparator = (opts: ParallelOptions, word: string): boolean =>
  separators(opts)
    .slice(2)
    .includes(wordOf(word) ?? LIVE)

/** The input groups after the command; any group read from a file or holding an expansion is unread. */
function readInputs(opts: ParallelOptions, marked: readonly string[], from: number): ParallelInputs {
  if (opts.argFile || from >= marked.length) return { kind: 'unread' }
  const groups: string[][] = []
  for (const word of marked.slice(from)) {
    if (isFileSeparator(opts, word)) return { kind: 'unread' }
    if (isSeparator(opts, word)) groups.push([])
    else if (hidden(word)) return { kind: 'unread' }
    else groups.at(-1)?.push(unmark(plain(word)))
  }
  return { kind: 'literal', groups }
}

/**
 * Reads GNU parallel's words after its name, from index `from`; `splits` is the command's
 * `SimpleCommand.splits`. It returns `unknownOption`, the word's index, for an option the guard does
 * not know (an abbreviation, a single-dash long name, `--rpl`, `--shebang`, `-J`), any word with
 * Getopt::Long's `+` option prefix (`+xargs`, `+j 4`), one it cannot
 * read, an expansion where an option may stand, or an option value the shell splits (`-j $N` may be
 * `1 git push`): the caller cannot tell what the command becomes. It refuses a command word that
 * runs perl (`{= … =}`) too, and a `--` anywhere: GNU reads it as the end of options, as part of
 * the command or as an input, but moreutils' `parallel` runs each word after it as a command or
 * starts its inputs there.
 */
export function parallelCall(
  marked: readonly string[],
  splits: readonly string[],
  from = 0,
): ParallelCall | { unknownOption: number } {
  const options = readParallelOptions(marked, splits, from)
  if (typeof options === 'number') return { unknownOption: options }
  const [opts, start] = options
  let end = start
  while (end < marked.length && !isSeparator(opts, marked[end] ?? '')) end++
  const refused = marked.findIndex(
    (word, i) => i >= start && (wordOf(word) === '--' || (i < end && runsPerl(word))),
  )
  if (refused >= 0) return { unknownOption: refused }
  return {
    command: marked.slice(start, end),
    quote: opts.quote,
    inputs: readInputs(opts, marked, end),
    replaceStrings: opts.replaceStrings,
  }
}

/** Whether `word` holds a parallel replacement string: `{}`, `{.}`, `{2/.}`, `{= perl =}` or a custom one. */
export function holdsReplacement(word: string, custom: readonly string[] = []): boolean {
  const read = unmark(word)
  return /\{[^{}\s]*\}/.test(read) || read.includes('{=') || custom.some(s => s !== '' && read.includes(s))
}
