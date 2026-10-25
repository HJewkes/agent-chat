/**
 * Shell startup files and Claude Code's `CLAUDE_ENV_FILE` (TP-4232). The Bash tool sources
 * `CLAUDE_ENV_FILE` before every command, and a shell reads its startup files, so a `GH_PATH`,
 * `PATH` or gh config variable written there reaches a later `gh auth setup-git` on a line the
 * guard reads without it. The guard cannot see that later environment, so it checks the write.
 */
import path from 'node:path'
import { LIVE, type SimpleCommand } from './shell-words.js'

type Env = Readonly<Record<string, string | undefined>>

// A prefix, so `~/.bash?c` and a `.zshenv` under ZDOTDIR count; `x.bash` is a script, not a startup
// file. Case-insensitive, as macOS's default filesystem is.
const STARTUP_FILE =
  /(?<![\w.-])\.(?:bash|zsh|zlog|zprofile|profile|kshrc|mkshrc|shrc)|\/etc\/(?:profile|bash|zsh|environment)|CLAUDE_ENV_FILE/i

/** Variables the hook may hold that name a file a later shell sources. */
const SOURCED_ENV = ['CLAUDE_ENV_FILE', 'BASH_ENV', 'ENV']

// `.ba""shrc` and `.ba\shrc` name `.bashrc`, so quoting is dropped before a name is looked for.
const QUOTING = /\\\n|['"\\]/g

/** Whether the text names a shell startup file, `CLAUDE_ENV_FILE`, or a file the hook's environment says a shell sources. */
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
 * Any use of a variable that picks the gh path git's credential helper runs or the config gh reads,
 * in text with `$NAME` and `${NAME}` reads already dropped, and zsh's `path` array as a variable.
 */
const HELPER_NAME =
  /(?<![A-Za-z0-9_])(?:GH_PATH|PATH|GH_CONFIG_DIR|XDG_CONFIG_HOME|HOME)(?![A-Za-z0-9_])|(?<![\w$./-])path(?:\[[^\]]*\])?\+?=/

/** Commands that only read files or print the words on the line. */
const PLAIN_COMMANDS = new Set(
  'cat grep egrep fgrep rg head tail wc ls stat file diff cmp less test [ [[ true : cd echo printf'.split(' '),
)

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

// A shell that sources the file expands `$` and backticks and joins a line ending in `\` to the next;
// echo and printf rewrite any other escape, and printf's directives build text the line does not show.
const SOURCED_CODE = /[$`\\]/
const ESCAPE = /\\(?![nt])/

/** Whether echo, printf or an operand-less cat writes text the line shows whole, ending in a newline. */
function writesLineText(head: string, args: readonly string[], cmd: SimpleCommand): boolean {
  if (head === 'cat') return args.length === 0 && cmd.stdin !== undefined && !cmd.stdinLive && !SOURCED_CODE.test(cmd.stdin)
  if (head !== 'echo' && head !== 'printf') return false
  const text = args.join(' ')
  if (args.some(arg => arg.startsWith('-')) || /[$`]/.test(text) || ESCAPE.test(text)) return false
  return head === 'echo' || (!text.includes('%') && text.endsWith('\\n'))
}

/** Whether a command on a line that names an env file may write it something the guard cannot read. */
function writesUnread(cmd: SimpleCommand, env: Env): boolean {
  if (cmd.arith) return false
  const at = cmd.words.findIndex(word => !ASSIGNMENT_WORD.test(word))
  if (at === -1) return false
  const head = path.basename(cmd.words[at] as string)
  if (!PLAIN_COMMANDS.has(head)) return true
  const targets = cmd.writes.filter(word => word.includes(LIVE) || namesEnvFile(word, env))
  if (targets.length === 0) return false
  const live = cmd.marked.slice(at + 1).some(word => word.includes(LIVE))
  return live || !writesLineText(head, cmd.words.slice(at + 1), cmd)
}

/**
 * Whether a line may put a gh helper or config variable into a startup file or `CLAUDE_ENV_FILE`:
 * it names one, and it names such a variable other than by a plain read, runs a command that is not
 * a plain read or print, or writes one text the line does not show whole. `said` is the line with
 * its `$NAME` reads dropped.
 */
export function writesEnvFile(command: string, said: string, cmds: readonly SimpleCommand[], env: Env): boolean {
  if (!namesEnvFile(command, env)) return false
  return HELPER_NAME.test(said) || cmds.some(cmd => writesUnread(cmd, env))
}

/** Whether an Edit or Write tool call changes a startup file or `CLAUDE_ENV_FILE`; its content runs in a later shell. */
export const editsEnvFile = (file: string, env: Env): boolean => namesEnvFile(file, env)
