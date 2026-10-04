import { GIT_BUILTINS } from './git-alias.js'
import { LIVE, NAME, unmark } from './shell-words.js'

/**
 * A `-c` or `--config-env` the guard cannot read before a command that runs hooks (TP-630). A word
 * the shell expands in a way the guard cannot tell may hold `include.path` or `core.hooksPath`.
 */

/** Builtins that run a client hook, or that run others which do. The rest, such as `log`, run none. */
const HOOK_RUNNING = new Set(
  `am bisect checkout cherry-pick clone commit fetch gc hook maintenance merge pull push rebase
  receive-pack revert stash switch worktree`.split(/\s+/),
)
const VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix'])
// A glob or brace word may expand to several words, one of them an option; a bare `$VAR` is one word.
const GLOBBED = new RegExp(`${LIVE}[*?[{(]`)
// What one word may expand to without becoming several: a plain scalar, a tilde, or a substitution inside quotes.
const SCALAR = new RegExp(
  `${LIVE}(?:\\$\\{${NAME}\\}|\\$${NAME}(?![A-Za-z0-9_]|${LIVE}?[:\\[])|\\$\\(|\`|~(?=/|$))`,
  'g',
)
const CONFIG_ENV_OPT = '--config-env='

/** One `-c` or `--config-env` value: its resolved word, and its marked source, where LIVE precedes what the shell expands. */
interface ConfigWord {
  resolved: string | undefined
  marked: string
  fromEnv: boolean
}

/** The part of a value that names the key: before the first `=` for `-c`, before the last for `--config-env`. */
function keyOf(marked: string, fromEnv: boolean): string {
  const eq = fromEnv ? marked.lastIndexOf('=') : marked.indexOf('=')
  return eq < 0 ? marked : marked.slice(0, eq)
}

/** A `-c` key that is not literal, or a `--config-env` key or variable name that is not. */
function unreadable({ resolved, marked, fromEnv }: ConfigWord): boolean {
  if (resolved !== undefined) return false
  if (!marked.includes('=') || keyOf(marked, fromEnv).includes(LIVE)) return true
  return fromEnv && marked.slice(marked.lastIndexOf('=') + 1).includes(LIVE)
}

/**
 * Whether the shell may turn the word into several, one of them an option. Only a literal, or a
 * double-quoted word whose expansions are plain scalars, is one word; anything else, such as `$@`,
 * `${a[@]}`, `${=v}`, a brace list, a glob or an unquoted expansion, may split.
 */
export const expandsToWords = (marked: string, splits: readonly string[]): boolean =>
  splits.includes(marked) || marked.replace(SCALAR, '').includes(LIVE)

/** A word that may expand to options, whatever else it holds. */
const UNKNOWN: ConfigWord = { resolved: undefined, marked: LIVE, fromEnv: false }

/** The `-c` or `--config-env` word at `i`, attached to its option or in the word after it. */
function configWord(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  i: number,
): { word: ConfigWord; width: number } | undefined {
  const raw = unmark(marked[i] as string)
  const word = resolved[i]
  if (raw === '-c' || raw === '--config-env')
    return {
      word: { resolved: resolved[i + 1], marked: marked[i + 1] ?? '', fromEnv: raw !== '-c' },
      width: 2,
    }
  if (raw.startsWith(CONFIG_ENV_OPT)) {
    const cut = CONFIG_ENV_OPT.length
    return {
      word: { resolved: word?.slice(cut), marked: (marked[i] as string).slice(cut), fromEnv: true },
      width: 1,
    }
  }
  if (!/^-c./.test(raw)) return undefined
  return {
    word: { resolved: word?.slice(2), marked: (marked[i] as string).slice(2), fromEnv: false },
    width: 1,
  }
}

/**
 * The config words in git's options before the subcommand, and the index of the subcommand. Every
 * word up to the subcommand, and the value of an option that takes one, must be one word, or it is UNKNOWN.
 */
function scanOptions(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): { words: ConfigWord[]; at: number } {
  const words: ConfigWord[] = []
  const splittable = (at: number): boolean =>
    at < marked.length && expandsToWords(marked[at] as string, splits)
  let i = 0
  for (; i < marked.length; i++) {
    const raw = unmark(marked[i] as string)
    // A bare `$VAR` here is the subcommand, which the callers read; a glob or brace word may be options.
    if (!raw.startsWith('-')) {
      if (!GLOBBED.test(marked[i] as string)) break
      words.push(UNKNOWN)
      continue
    }
    if (splittable(i)) words.push(UNKNOWN)
    const config = configWord(resolved, marked, i)
    const takesValue = config?.width === 2 || VALUE_OPTS.has(raw)
    if (takesValue && splittable(i + 1)) words.push(UNKNOWN)
    if (config) words.push(config.word)
    if (takesValue) i++
  }
  return { words, at: i }
}

/** Whether git's options hold a config word the guard cannot read, whatever the subcommand. */
export const hasUnreadableOption = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): boolean => scanOptions(resolved, marked, splits).words.some(unreadable)

/** Whether git's options hold a config word the guard cannot read and the subcommand may run a hook. */
export function hasUnreadableConfig(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): boolean {
  const { words, at } = scanOptions(resolved, marked, splits)
  // The words the shell splits may hide `-c` before the visible subcommand, so that one is not trusted.
  if (words.includes(UNKNOWN)) return true
  if (!words.some(unreadable)) return false
  const sub = resolved[at]
  return sub === undefined || HOOK_RUNNING.has(sub) || !GIT_BUILTINS.has(sub)
}

// zsh matches a group against names, so an alternative, the text glued before it or text glued after it may be an option.
const QUOTING_CHARS = /['"\\]/g
const OPTION_GROUP = /^-|[(|)]-/

/** Whether an argument after the subcommand may expand to an option through a glob group (CC-728). */
export function hasOptionAlternation(
  marked: readonly string[],
  splits: readonly string[],
  resolved: readonly (string | undefined)[],
): boolean {
  const { at } = scanOptions(resolved, marked, splits)
  const groups = marked.slice(at + 1).filter(word => word.includes(`${LIVE}(`))
  return (
    resolved[at] !== undefined &&
    groups.some(word => OPTION_GROUP.test(unmark(word).replace(QUOTING_CHARS, '')))
  )
}

/** Whether git's options hold a word the shell may split into several, which quoting would fix. */
export const hasSplittableOption = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): boolean => scanOptions(resolved, marked, splits).words.includes(UNKNOWN)
