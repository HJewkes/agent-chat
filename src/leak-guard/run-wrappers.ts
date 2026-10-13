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
  /** `undefined` when the words ran out first: find refuses that, but the words are read anyway. */
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
    const ends = word === ';' || (word === '+' && unmark(marked[i - 1] ?? '') === '{}' && i > from)
    if (ends) return [{ action, at: from, words: marked.slice(from, i), terminator: word }, i + 1]
  }
  return [{ action, at: from, words: marked.slice(from), terminator: undefined }, marked.length]
}

/** Every action clause in `marked` (find's words after its name), from index `from`. */
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

/** Long options that take a value, without the leading `--`. */
const PARALLEL_LONG_VALUE: ReadonlySet<string> = new Set(
  [
    'arg-file arg-file-sep arg-sep delimiter colsep jobs max-procs max-args max-replace-args',
    'max-lines max-chars sshlogin joblog results halt tagstring env workdir timeout delay memfree',
    'load block tmpdir header retries nice extensionreplace basenamereplace dirnamereplace',
    'seqreplace slotreplace',
  ]
    .join(' ')
    .split(' '),
)

const PARALLEL_LONG_FLAG: ReadonlySet<string> = new Set(
  [
    'null keep-order quote ungroup verbose xargs no-run-if-empty pipe pipepart group line-buffer lb',
    'tag dry-run bar progress eta will-cite plus shuf no-notice',
  ]
    .join(' ')
    .split(' '),
)

const PARALLEL_SHORT_VALUE = new Set('adEIjPnNLsSC')
const PARALLEL_SHORT_FLAG = new Set('0kquvXmtprx')

const LONG_ALIAS: ReadonlyMap<string, string> = new Map([
  ['arg-file', 'a'],
  ['quote', 'q'],
])

/** Options whose value changes where the command's input lands or which words separate inputs. */
const REPLACE_OPTIONS: ReadonlySet<string> = new Set([
  'I',
  'extensionreplace',
  'basenamereplace',
  'dirnamereplace',
  'seqreplace',
  'slotreplace',
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
  const alias = LONG_ALIAS.get(name) ?? name
  if (PARALLEL_LONG_FLAG.has(name) && eq < 0) return [[{ name: alias, value: undefined }], 1]
  if (!PARALLEL_LONG_VALUE.has(name)) return null
  const value = eq < 0 ? next : word.slice(eq + 1)
  if (value === undefined) return null
  return [[{ name: alias, value }], eq < 0 ? 2 : 1]
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
    if (!PARALLEL_SHORT_VALUE.has(letter)) return null
    const attached = word.slice(i + 1)
    const value = attached === '' ? next : attached
    if (value === undefined) return null
    options.push({ name: letter, value })
    return [options, attached === '' ? 2 : 1]
  }
  return [options, 1]
}

/** Folds one read option into `opts`; false when its value is unreadable but decides structure. */
function applyOption(opts: ParallelOptions, { name, value }: Option): boolean {
  const structural = REPLACE_OPTIONS.has(name) || name === 'arg-sep' || name === 'arg-file-sep'
  if (value !== undefined && structural && hidden(value)) return false
  const read = value === undefined ? '' : unmark(plain(value))
  if (name === 'q') opts.quote = true
  if (name === 'a') opts.argFile = true
  if (REPLACE_OPTIONS.has(name)) opts.replaceStrings.push(read)
  if (name === 'arg-sep') opts.argSep = read
  if (name === 'arg-file-sep') opts.argFileSep = read
  return true
}

/** The options before the command and the index of the first word after them, or the unknown option's index. */
function readParallelOptions(marked: readonly string[], from: number): [ParallelOptions, number] | number {
  const opts: ParallelOptions = {
    quote: false,
    argFile: false,
    replaceStrings: [],
    argSep: ':::',
    argFileSep: '::::',
  }
  let i = from
  while (i < marked.length) {
    const word = marked[i] ?? ''
    if (word === '--') return [opts, i + 1]
    if (plain(word).startsWith(LIVE)) return i
    if (!word.startsWith('-') || word === '-' || isSeparator(opts, word)) return [opts, i]
    if ((word.split('=')[0] ?? '').includes(LIVE)) return i
    const read = word.startsWith('--') ? readLong(word, marked[i + 1]) : readCluster(word, marked[i + 1])
    if (read === null || !read[0].every(option => applyOption(opts, option))) return i
    i += read[1]
  }
  return [opts, i]
}

const isSeparator = (opts: ParallelOptions, word: string): boolean =>
  [opts.argSep, opts.argSep + '+', opts.argFileSep, opts.argFileSep + '+', '--'].includes(word)

/** The input groups after the command; any group read from a file or holding an expansion is unread. */
function readInputs(opts: ParallelOptions, marked: readonly string[], from: number): ParallelInputs {
  if (opts.argFile || from >= marked.length) return { kind: 'unread' }
  const groups: string[][] = []
  for (const word of marked.slice(from)) {
    if (word === opts.argFileSep || word === opts.argFileSep + '+') return { kind: 'unread' }
    if (isSeparator(opts, word)) groups.push([])
    else if (hidden(word)) return { kind: 'unread' }
    else groups.at(-1)?.push(unmark(plain(word)))
  }
  return { kind: 'literal', groups }
}

/**
 * Reads GNU parallel's words after its name, from index `from`. An option the guard does not know
 * (an abbreviation, a single-dash long name, `--rpl`, `--shebang`, `-J`), one it cannot read, or an
 * expansion where an option may stand returns `unknownOption`, its index: the caller cannot tell what the command becomes. A literal
 * `--` after the command is read as an input separator too, which covers moreutils' `parallel`.
 */
export function parallelCall(marked: readonly string[], from = 0): ParallelCall | { unknownOption: number } {
  const options = readParallelOptions(marked, from)
  if (typeof options === 'number') return { unknownOption: options }
  const [opts, start] = options
  let end = start
  while (end < marked.length && !isSeparator(opts, marked[end] ?? '')) end++
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
