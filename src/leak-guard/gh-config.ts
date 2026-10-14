/**
 * gh runs the `pager`, `editor` and `browser` values that `gh config set` stores as programs on
 * later calls (TP-2533), the config twin of `GH_PAGER`, `GH_EDITOR` and `GH_BROWSER`. The guard
 * checks such a value when `gh config set` writes it.
 */

/** What a `gh config set` call writes: a program value to check, or `unread` when the guard cannot tell. */
export type GhConfigProgram = { kind: 'program'; value: string } | { kind: 'unread' }

/**
 * Keys gh 2.102 runs as programs. gh's lookup is exact; comparing lower-cased over-denies a
 * mixed-case key, which gh would store but never run, rather than miss one.
 */
const PROGRAM_KEYS = new Set(['pager', 'editor', 'browser'])

type FlagRead = 'help' | 'host' | 'hostNext' | 'unknown'

/** One flag word of `gh config set`, which knows only `-h|--host <host>` and `--help`. */
function readFlag(word: string): FlagRead {
  if (word === '--help') return 'help'
  if (word === '-h' || word === '--host') return 'hostNext'
  if (word.startsWith('--host=') || (word.startsWith('-h') && !word.startsWith('--'))) return 'host'
  return 'unknown'
}

interface Positionals {
  words: (string | undefined)[]
  /** Whether `-h`/`--host` took an unresolved word, which an unquoted expansion may split into a key and value. */
  hostUnread: boolean
}

/**
 * The positional words of `gh config set`, `unread` for a flag the guard does not know, or `help`.
 * An unresolved word before `--help` may be `--`, which makes `--help` a positional, so it reads `unread`.
 */
function positionals(rest: readonly (string | undefined)[]): Positionals | 'unread' | 'help' {
  const words: (string | undefined)[] = []
  let hostUnread = false
  let parsing = true
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]
    if (parsing && word === '--') parsing = false
    else if (parsing && word !== undefined && word.length > 1 && word.startsWith('-')) {
      const flag = readFlag(word)
      if (flag === 'unknown') return 'unread'
      if (flag === 'help') return rest.slice(0, i).includes(undefined) ? 'unread' : 'help'
      if (flag === 'hostNext') hostUnread ||= i + 1 < rest.length && rest[++i] === undefined
    } else words.push(word)
  }
  return { words, hostUnread }
}

/** What the positionals write, before an unresolved host word is taken into account. */
function programWrite(words: readonly (string | undefined)[]): GhConfigProgram | undefined {
  if (words.length < 2) return words.includes(undefined) ? { kind: 'unread' } : undefined
  const [key, value] = words
  if (key === undefined) return { kind: 'unread' }
  if (!PROGRAM_KEYS.has(key.toLowerCase())) return undefined
  return value === undefined ? { kind: 'unread' } : { kind: 'program', value }
}

/**
 * `rest` is every word of `gh config set` after its two command words, undefined where the guard
 * cannot resolve one. Flags may come anywhere before `--`, as pflag reads them. Returns undefined
 * when the call writes no program key, including a call missing its key or value, which gh rejects.
 * Past an unresolved host word only a program write stays read: that word may itself hold a
 * program key (`-h $H` with `H="a --host= pager"`), so any other reading is `unread`.
 */
export function ghConfigProgram(rest: readonly (string | undefined)[]): GhConfigProgram | undefined {
  const read = positionals(rest)
  if (read === 'help') return undefined
  if (read === 'unread') return { kind: 'unread' }
  const write = programWrite(read.words)
  return read.hostUnread && write?.kind !== 'program' ? { kind: 'unread' } : write
}
