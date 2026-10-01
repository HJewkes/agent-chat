import { GIT_BUILTINS } from './git-alias.js'

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
const CONFIG_ENV_OPT = '--config-env='
const EXPANDS = /[$`]/

/** One `-c` or `--config-env` value: its resolved word, and its source text with expansions kept. */
interface ConfigWord {
  resolved: string | undefined
  raw: string
  fromEnv: boolean
}

/** The raw part of a value that names the key: before the first `=` for `-c`, before the last for `--config-env`. */
function rawKey(raw: string, fromEnv: boolean): string {
  const eq = fromEnv ? raw.lastIndexOf('=') : raw.indexOf('=')
  return eq < 0 ? raw : raw.slice(0, eq)
}

/** A `-c` key that is not literal, or a `--config-env` key or variable name that is not. */
function unreadable({ resolved, raw, fromEnv }: ConfigWord): boolean {
  if (resolved !== undefined) return false
  const eq = raw.indexOf('=')
  if (eq < 0 || EXPANDS.test(rawKey(raw, fromEnv))) return true
  return fromEnv && EXPANDS.test(raw.slice(raw.lastIndexOf('=') + 1))
}

/** The config words in git's options before the subcommand, and the index of the subcommand. */
function scanOptions(
  resolved: readonly (string | undefined)[],
  args: readonly string[],
): { words: ConfigWord[]; at: number } {
  const words: ConfigWord[] = []
  let i = 0
  for (; i < args.length && (args[i] as string).startsWith('-'); i++) {
    const raw = args[i] as string
    const word = resolved[i]
    if (raw === '-c' || raw === '--config-env') {
      words.push({ resolved: resolved[i + 1], raw: args[i + 1] ?? '', fromEnv: raw !== '-c' })
      i++
    } else if (raw.startsWith(CONFIG_ENV_OPT))
      words.push({
        resolved: word?.slice(CONFIG_ENV_OPT.length),
        raw: raw.slice(CONFIG_ENV_OPT.length),
        fromEnv: true,
      })
    else if (/^-c./.test(raw)) words.push({ resolved: word?.slice(2), raw: raw.slice(2), fromEnv: false })
    else if (VALUE_OPTS.has(raw)) i++
  }
  return { words, at: i }
}

/** Whether git's options hold a config word the guard cannot read and the subcommand may run a hook. */
export function hasUnreadableConfig(
  resolved: readonly (string | undefined)[],
  args: readonly string[],
): boolean {
  const { words, at } = scanOptions(resolved, args)
  if (!words.some(unreadable)) return false
  const sub = resolved[at]
  return sub === undefined || HOOK_RUNNING.has(sub) || !GIT_BUILTINS.has(sub)
}
