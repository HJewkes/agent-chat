import { GIT_BUILTINS } from './git-alias.js'
import { LIVE, unmark } from './shell-words.js'

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
const GLOBBED = new RegExp(`${LIVE}[*?[{]`)
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

/** A word that may expand to options, whatever else it holds. */
const UNKNOWN: ConfigWord = { resolved: undefined, marked: LIVE, fromEnv: false }

/** The config words in git's options before the subcommand, and the index of the subcommand. */
function scanOptions(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
): { words: ConfigWord[]; at: number } {
  const words: ConfigWord[] = []
  let i = 0
  for (; i < marked.length; i++) {
    const raw = unmark(marked[i] as string)
    const word = resolved[i]
    // A word the shell expands may itself be options, as `{core.hooksPath=x,-p}` is.
    if (word === undefined && GLOBBED.test(marked[i] as string)) words.push(UNKNOWN)
    else if (!raw.startsWith('-')) break
    else if (raw === '-c' || raw === '--config-env') {
      words.push({ resolved: resolved[i + 1], marked: marked[i + 1] ?? '', fromEnv: raw !== '-c' })
      i++
    } else if (raw.startsWith(CONFIG_ENV_OPT))
      words.push({
        resolved: word?.slice(CONFIG_ENV_OPT.length),
        marked: (marked[i] as string).slice(CONFIG_ENV_OPT.length),
        fromEnv: true,
      })
    else if (/^-c./.test(raw))
      words.push({ resolved: word?.slice(2), marked: (marked[i] as string).slice(2), fromEnv: false })
    else if (VALUE_OPTS.has(raw)) {
      // The value may expand to more options too, as `-C {.,-c,core.hooksPath=x}` does.
      if (resolved[i + 1] === undefined && GLOBBED.test(marked[i + 1] ?? '')) words.push(UNKNOWN)
      i++
    }
  }
  return { words, at: i }
}

/** Whether git's options hold a config word the guard cannot read and the subcommand may run a hook. */
export function hasUnreadableConfig(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
): boolean {
  const { words, at } = scanOptions(resolved, marked)
  if (!words.some(unreadable)) return false
  const sub = resolved[at]
  return sub === undefined || HOOK_RUNNING.has(sub) || !GIT_BUILTINS.has(sub)
}
