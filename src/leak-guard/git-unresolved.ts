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
const CONFIG_OPT = '--config='

/**
 * One `-c`, `--config` or `--config-env` value: its resolved word, its marked source, where LIVE
 * precedes what the shell expands, and the index of the word that holds it, if one does.
 */
export interface ConfigWord {
  resolved: string | undefined
  marked: string
  fromEnv: boolean
  index?: number
}

/** The part of a value that names the key: before the first `=` for `-c`, before the last for `--config-env`. */
export function keyOf(marked: string, fromEnv: boolean): string {
  const eq = fromEnv ? marked.lastIndexOf('=') : marked.indexOf('=')
  return eq < 0 ? marked : marked.slice(0, eq)
}

/** A `-c` key that is not literal, or a `--config-env` key or variable name that is not. */
export function unreadable({ resolved, marked, fromEnv }: ConfigWord): boolean {
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

/** The value glued to an option at `i` after `cut` characters. */
const glued = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  i: number,
  cut: number,
  fromEnv: boolean,
): { word: ConfigWord; width: number } => ({
  word: { resolved: resolved[i]?.slice(cut), marked: (marked[i] as string).slice(cut), fromEnv, index: i },
  width: 1,
})

/** The `-c`, `--config` or `--config-env` word at `i`, attached to its option or in the word after it. */
function configWord(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  i: number,
): { word: ConfigWord; width: number } | undefined {
  const raw = unmark(marked[i] as string)
  if (raw === '-c' || raw === '--config' || raw === '--config-env')
    return {
      word: {
        resolved: resolved[i + 1],
        marked: marked[i + 1] ?? '',
        fromEnv: raw === '--config-env',
        index: i + 1,
      },
      width: 2,
    }
  if (raw.startsWith(CONFIG_ENV_OPT)) return glued(resolved, marked, i, CONFIG_ENV_OPT.length, true)
  if (raw.startsWith(CONFIG_OPT)) return glued(resolved, marked, i, CONFIG_OPT.length, false)
  return /^-c./.test(raw) ? glued(resolved, marked, i, 2, false) : undefined
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

/**
 * The `-c` and `--config` words `git clone` applies to the new repository before it fetches or
 * checks out, so a program they set runs in the same call (TP-636). A word the shell may split
 * may hide one, so it is UNKNOWN.
 */
function cloneConfigWords(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
  at: number,
): ConfigWord[] {
  if (resolved[at] !== 'clone') return []
  const words: ConfigWord[] = []
  for (let i = at + 1; i < marked.length && unmark(marked[i] as string) !== '--'; i++) {
    if (expandsToWords(marked[i] as string, splits)) words.push(UNKNOWN)
    const config = configWord(resolved, marked, i)
    if (config === undefined) continue
    words.push(config.word)
    i += config.width - 1
  }
  return words
}

/** Every config word this git invocation receives: git's own options, then those its subcommand applies. */
function invocationConfig(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): { words: ConfigWord[]; at: number } {
  const { words, at } = scanOptions(resolved, marked, splits)
  return { words: [...words, ...cloneConfigWords(resolved, marked, splits, at)], at }
}

/** Every `-c`, `--config` and `--config-env` word this git invocation receives. */
export const configWords = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): ConfigWord[] => invocationConfig(resolved, marked, splits).words

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
  const { words, at } = invocationConfig(resolved, marked, splits)
  // The words the shell splits may hide `-c` before the visible subcommand, so that one is not trusted.
  if (words.includes(UNKNOWN)) return true
  if (!words.some(unreadable)) return false
  const sub = resolved[at]
  return sub === undefined || HOOK_RUNNING.has(sub) || !GIT_BUILTINS.has(sub)
}

// zsh matches a group against names, so an alternative, the text glued before it or text glued after it may be an option.
const QUOTING_CHARS = /['"\\]/g
const OPTION_GROUP = /^-|[(|)]-|[(|)]\[[^\]]*-/
// A bracket class that holds `-`, as in `[-]-no-verify`, or an option-shaped word with a class in it, may spell an option.
const OPTION_CLASS = /^-*\[[^\]]*-|^-.*\[/

const spellsOption = (word: string): boolean => {
  const text = unmark(word).replace(QUOTING_CHARS, '')
  return (
    (word.includes(`${LIVE}(`) && OPTION_GROUP.test(text)) ||
    (word.includes(`${LIVE}[`) && OPTION_CLASS.test(text))
  )
}

/** Whether an argument after the subcommand may expand to an option through a glob group or bracket class (CC-728). */
export function hasOptionAlternation(
  marked: readonly string[],
  splits: readonly string[],
  resolved: readonly (string | undefined)[],
): boolean {
  const { at } = scanOptions(resolved, marked, splits)
  return resolved[at] !== undefined && marked.slice(at + 1).some(spellsOption)
}

/** Whether git's options hold a word the shell may split into several, which quoting would fix. */
export const hasSplittableOption = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): boolean => scanOptions(resolved, marked, splits).words.includes(UNKNOWN)
