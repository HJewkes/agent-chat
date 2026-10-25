/**
 * Files a later shell sources (TP-4232): shell startup files, Claude Code's `CLAUDE_ENV_FILE`,
 * session-env and shell snapshots. Whatever lands there runs in a later shell the guard never reads,
 * where it may set the gh path or config a `gh auth setup-git` uses, so only the owner changes them.
 */
import type { SimpleCommand } from './shell-words.js'

type Env = Readonly<Record<string, string | undefined>>

// A prefix, so `~/.bash?c` and a `.zshenv` under ZDOTDIR count; `x.bash` is a script, not a startup
// file. Case-insensitive, as macOS's default filesystem is.
// Claude Code keeps the files it sources for a session's SessionStart hooks under `session-env`,
// named `sessionstart-hook-<n>.sh`, and sources a `shell-snapshots` file before every Bash call;
// each name counts, so a `cd` before a relative path does too.
const STARTUP_FILE =
  /(?<![\w.-])\.(?:bash|zsh|zlog|zprofile|profile|kshrc|mkshrc|shrc)|\/etc\/(?:profile|bash|zsh|environment)|CLAUDE_ENV_FILE|session-env|sessionstart-hook|shell-snapshots/i

/** Variables the hook may hold that name a file a later shell sources. */
const SOURCED_ENV = ['CLAUDE_ENV_FILE', 'BASH_ENV', 'ENV']

// `.ba""shrc` and `.ba\shrc` name `.bashrc`, so quoting is dropped before a name is looked for.
const QUOTING = /\\\n|['"\\]/g

/** Whether the text names a shell startup file, `CLAUDE_ENV_FILE`, a Claude session-env or shell snapshot, or a file the hook's environment says a shell sources. */
export function namesEnvFile(text: string, env: Env): boolean {
  const plain = text.replace(QUOTING, '')
  return (
    STARTUP_FILE.test(plain) ||
    SOURCED_ENV.some(name => {
      const file = env[name]
      return file !== undefined && file !== '' && plain.includes(file)
    })
  )
}

/**
 * Commands that only read files or print the words on the line, and take no option that runs a
 * program: `less` runs `LESSOPEN` and `rg` runs `--pre`, so neither is here.
 */
const PLAIN_COMMANDS = new Set(
  'cat grep egrep fgrep head tail wc ls stat file diff cmp test [ [[ true : cd echo printf'.split(' '),
)

/**
 * A command that only reads or prints: its first word is a bare plain command, so neither a prefix
 * assignment nor a path (`/tmp/x/cat` may be any program) stands there, and it writes nowhere but
 * /dev/null.
 */
function onlyReads(cmd: SimpleCommand): boolean {
  if (cmd.arith) return true // its substitutions are separate entries in the parse
  const [head] = cmd.words
  return head !== undefined && PLAIN_COMMANDS.has(head) && cmd.writes.every(word => word === '/dev/null')
}

/**
 * Startup files, CLAUDE_ENV_FILE, Claude's session-env and shell snapshots are owner-only: a later
 * shell runs whatever lands there, and whether a `NAME=value` line is inert depends on who reads
 * NAME later, so a line that names one may only read it. An empty parse is a bare redirection,
 * which zsh runs as `cat`, so it never proves a read.
 */
export function writesEnvFile(command: string, cmds: readonly SimpleCommand[], env: Env): boolean {
  if (!namesEnvFile(command, env)) return false
  return cmds.length === 0 || !cmds.every(onlyReads)
}

/** Whether an Edit or Write tool call changes a file a later shell sources. */
export const editsEnvFile = (file: string, env: Env): boolean => namesEnvFile(file, env)
