/**
 * Files a later shell sources (TP-4232): shell startup files, Claude Code's `CLAUDE_ENV_FILE`,
 * session-env and shell snapshots. Whatever lands there runs in a later shell the guard never reads,
 * where it may set the gh path or config a `gh auth setup-git` uses, so the Edit tools leave them to
 * the owner. Bash lines that write them are TP-4256's runtime check: a line's text cannot show it.
 */
import fs from 'node:fs'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

// A prefix, so `~/.bash?c` and a `.zshenv` under ZDOTDIR count; `x.bash` is a script, not a startup
// file. Case-insensitive, as macOS's default filesystem is.
// Claude Code keeps the files it sources for a session's SessionStart hooks under `session-env`,
// named `sessionstart-hook-<n>.sh`, and sources a `shell-snapshots` file before every Bash call.
const STARTUP_FILE =
  /(?<![\w.-])\.(?:bash|zsh|zlog|zprofile|profile|kshrc|mkshrc|shrc)|\/etc\/(?:profile|bash|zsh|environment)|CLAUDE_ENV_FILE|session-env|sessionstart-hook|shell-snapshots/i

/** Variables the hook may hold that name a file a later shell sources. */
const SOURCED_ENV = ['CLAUDE_ENV_FILE', 'BASH_ENV', 'ENV']

// Linux's SYMLOOP_MAX; a longer chain cannot be written through either.
const MAX_LINKS = 40

const readLink = (file: string): string | undefined => {
  try {
    return fs.readlinkSync(file)
  } catch {
    return undefined
  }
}

/**
 * The real path a write to the absolute `file` lands on, though the file may not exist yet: the
 * real path of its nearest existing parent plus the rest, following a dangling symlink to its
 * target, since a write through one creates the target.
 */
export function realTarget(file: string, links = MAX_LINKS): string {
  try {
    return fs.realpathSync(file)
  } catch {
    const parent = path.dirname(file)
    if (parent === file) return file
    const joined = path.join(realTarget(parent, links), path.basename(file))
    const link = readLink(joined)
    if (link === undefined || links === 0) return joined
    return realTarget(path.resolve(path.dirname(joined), link), links - 1)
  }
}

/** Whether the hook's value for `name` is an absolute path that one of the targets is. */
function isSourcedValue(env: Env, name: string, targets: readonly string[]): boolean {
  const value = env[name]
  if (value === undefined || !path.isAbsolute(value)) return false
  return targets.includes(path.resolve(value)) || targets.includes(realTarget(value))
}

/**
 * Whether an Edit or Write tool call on the absolute `file` changes a file a later shell sources.
 * Both the path as given and its real path count: a symlink elsewhere may point at `~/.zshenv`, and
 * `~/.zshenv` may itself be a symlink into a dotfiles checkout.
 */
export function editsEnvFile(file: string, env: Env): boolean {
  const targets = [file, realTarget(file)]
  return (
    targets.some(target => STARTUP_FILE.test(target)) ||
    SOURCED_ENV.some(name => isSourcedValue(env, name, targets))
  )
}
