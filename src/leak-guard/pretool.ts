import fs from 'node:fs'
import path from 'node:path'
import { matchRules, parseTerms, type TermRule } from '@titan-design/egress-scan'
import {
  aliasReader,
  CONFIG_ENV,
  configEnvVars,
  fillsUnsafely,
  gitCall,
  gitGlobals,
  gitOptions,
  GIT_VALUE_OPTS,
  quoted,
  UNSURE_CALL,
  shellAlias,
  splitAlias,
  unfillableAtSet,
  type GitCall,
  type Overrides,
  type ReadAlias,
} from './git-alias.js'
import { crashCause, type FailOpen } from './failopen.js'
import {
  configPrograms,
  extEnablerWrite,
  extPrograms,
  listsExt,
  OPAQUE_PROGRAM_ENV,
  PROGRAM_ENV,
  PROTOCOL_ENV,
} from './git-programs.js'
import { gitScripts, type ScriptSpan } from './git-scripts.js'
import { findClauses, type FindClause } from './run-wrappers.js'
import { SSH_PROGRAMS, sshRunsLocalProgram } from './ssh-options.js'
import {
  execPathOption,
  SHELL_CODE_ENV,
  templateOption,
  TRUST_ENV,
  trustConfigWrite,
  trustKey,
  type TrustEnv,
} from './trust-inputs.js'
import { classifyApiRead } from './gh-api-read.js'
import {
  ghAliasReader,
  ghAliasSet,
  ghAliasesAt,
  ghAliasesUnder,
  ghAliasSlot,
  GH_CLONES,
  ghCloneArgs,
  ghCommand,
  ghCommandWords,
  ghConfigDir,
  ghExtensionSlot,
  ghHelpRunsExtension,
  ghPlainAlias,
  ghShellAlias,
  HIDDEN,
  type GhAlias,
  type GhAliasSet,
  type ReadGhAliases,
} from './gh-runs.js'
import {
  expandsToWords,
  hasOptionAlternation,
  hasSplittableOption,
  hasUnreadableConfig,
  hasUnreadableOption,
} from './git-unresolved.js'
import { mayExpandTo, mayExpandToGit } from './git-word.js'
import { includedHooksPathReader, includesConfig, type ReadIncludedHooksPath } from './git-include.js'
import { hooksDirOf, MISSING_TERMS_REFUSES } from './hooks-dir.js'
import {
  expandWord,
  expansionRisk,
  HOLE,
  LIVE,
  mixesParenAndGuarded,
  NAME,
  parseShell,
  unmark,
  type SimpleCommand,
  type Substitution,
} from './shell-words.js'

/**
 * The PreToolUse bypass guard every spawned agent runs (CC-270). It denies the ordinary ways
 * to skip the pre-push leak scan, and PR or issue text with a finding before it is posted.
 * A command-string check is a speed bump, not a boundary: docs/leak-guard.md lists the gaps.
 * Every deny reason is a fixed phrase plus locations and rule ids, never the matched text.
 */

export type TermsLoad = { kind: 'ok'; rules: TermRule[] } | { kind: 'missing' } | { kind: 'unreadable' }

type Env = Readonly<Record<string, string | undefined>>

export interface GuardContext {
  terms: TermsLoad
  cwd: string
  /** The hook's own environment, which `~` and `$VAR` in a gh argument are expanded from. */
  env: Env
  /** Absolute paths and path fragments an agent may not touch: the hook dir, the term list and, for a worker, agent-chat's profiles and config. */
  protectedPaths: readonly string[]
  readFile(file: string): string | undefined
  readAlias: ReadAlias
  readIncludedHooksPath: ReadIncludedHooksPath
  /** gh's aliases from the config the hook's environment points at; without it no gh alias is followed. */
  readGhAliases?: ReadGhAliases
  /** `realpath` proved that `agent-chat` on the hook's `PATH` is the hook's own entry script, whose `gh-write` scans at run time. */
  scansGhWrite?: boolean
  /** The real path of that install and of the `PATH` directory that holds it, which a body file may not be or share. */
  install?: { file: string; dir: string }
}

/** What the guard knows of the shell before one command; undefined where it cannot tell. */
interface Scope {
  cwd: string | undefined
  env: Env | undefined
  /** The last `cd` ran only if the command before its `&&` succeeded. */
  fragile: boolean
  /** `CDPATH` may be set, so a relative `cd` may land somewhere else. */
  cdpath: boolean
  /** The command line names git or gh, so a script the guard cannot read may run either. */
  namesGit: boolean
  /** How many git or gh aliases the guard has expanded to reach this command. */
  aliases: number
  /** Variables earlier commands set, unset (undefined) or changed in a way the guard cannot tell (UNSURE). */
  exports: ReadonlyMap<string, Setting>
  /** The files earlier commands on this line wrote, as a path key; undefined where the guard cannot tell which. */
  written: readonly (string | undefined)[]
  /** The words of the commands before this one, to find a body path inside a script or a flag value. */
  earlier: readonly string[]
  /** The command line so far with `$NAME` references and quoting removed, to find names it may assign. */
  said: string
  /** The whole command line the agent sent, before any shell or alias the guard descends into. */
  line: string
  /** The `-c` and `--config-env` options of the git whose `!` alias runs this command. */
  gitParams: readonly string[]
  /** Where earlier commands on the line write: the path key of a literal target, undefined for any other. */
  targets: readonly (string | undefined)[]
  /** Every command before this one on the line is from a short set that cannot change what `agent-chat` resolves to. */
  deferrable: boolean
  /** Command starts after an expansion the whole call may still check; nested shells draw on the same budget. */
  hiddenStarts: { left: number; reachesGit?: boolean }
}

const UNSURE = Symbol('unsure')
type Setting = string | undefined | typeof UNSURE

const DOCS = 'See docs/leak-guard.md.'

// The one-call form the guard reads as it stands, and gh-write scans again when it runs (CC-887).
const HEREDOC_POST =
  "Post the text in the same call as a quoted heredoc: agent-chat gh-write -- <gh args> --body-file - <<'EOF', then the text, then EOF on its own line."

const MAX_DEPTH = 6
const MAX_ALIASES = 4
const MAX_HIDDEN_STARTS = 64

export const REASONS = {
  noVerify: `leak-guard: git push --no-verify skips the pre-push leak scan. Push without it. ${DOCS}`,
  gitConfig: `leak-guard: git -c or --config-env on core.hooksPath or an alias would bypass the pre-push leak scan. ${DOCS}`,
  configWrite: `leak-guard: writing core.hooksPath, or an alias that skips hooks, is not allowed for agents. ${DOCS}`,
  assignmentSubscript: `leak-guard: a word that opens an assignment subscript, NAME[...], but is not a complete NAME[idx]=value, so the guard cannot tell where the command starts. Keep the subscript free of blanks, or run the command without a prefix assignment. ${DOCS}`,
  gitConfigEnv: `leak-guard: setting, exporting or unsetting GIT_CONFIG_* would switch off the pre-push leak scan. ${DOCS}`,
  envClear: `leak-guard: env -i clears the variables that run the pre-push leak scan. ${DOCS}`,
  protectedPath: `leak-guard: the leak guard's hook directory and private term list are off limits to agents. ${DOCS}`,
  tooDeep: `leak-guard: the command nests shells too deeply to check. Run it more directly. ${DOCS}`,
  stdinBody: `leak-guard: a PR or issue body read from a pipe cannot be checked. ${HEREDOC_POST} ${DOCS}`,
  unreadableBody: `leak-guard: this command's PR or issue text could not be read the way the shell will read it, so it was not checked. Use literal arguments. ${HEREDOC_POST} ${DOCS}`,
  heredocBackslash: `leak-guard: a heredoc in this command holds a backslash, which a shell may rewrite: it joins a line that ends in one, and under an unquoted delimiter it escapes the next character. So this PR or issue text was not checked. Remove the backslash, or write the text to a file and pass --body-file. ${DOCS}`,
  hiddenCommand: `leak-guard: the command word is an expansion, so the guard cannot tell what this runs. Write git or gh out literally. ${DOCS}`,
  hiddenBody: `leak-guard: the command word is an expansion, so the guard cannot tell which directory or variables gh reads this PR or issue text with, and did not check it. Write the command out literally: agent-chat gh-write -- <gh args> --body-file <path>. ${HEREDOC_POST} ${DOCS}`,
  hiddenStarts: `leak-guard: this command line has more than ${MAX_HIDDEN_STARTS} command starts after expanded command words, more than the guard checks, and it may run git or gh. Split it into shorter Bash calls. ${DOCS}`,
  hiddenScript: `leak-guard: eval of text the guard cannot read, on a command line that names git or gh. Run the command directly. ${DOCS}`,
  missingTerms: `leak-guard: no private term list, so PR and issue text cannot be checked. Create ~/.config/titan-egress/private-terms, one term per line, chmod 600. ${DOCS}`,
  xargsOption: `leak-guard: xargs with an option this guard does not know, so it cannot tell which word is the command. Spell the option in full, or run the command without xargs. ${DOCS}`,
  sudoOption: `leak-guard: sudo with an option this guard does not know, so it cannot tell which word is the command. Spell the option in full, or run the command without sudo. ${DOCS}`,
  unreadableTerms: `leak-guard: the private term list could not be read, so PR and issue text cannot be checked. ${DOCS}`,
  aliasEnv: `leak-guard: the guard cannot tell which directory or config this git command runs with, or which subcommand it names, so it cannot tell what a git alias here runs. Run the command the alias stands for, from a plain cd. ${DOCS}`,
  aliasDepth: `leak-guard: git aliases here expand more than 4 deep, so the guard cannot tell what this runs. Run the git command directly. ${DOCS}`,
  includePath: `leak-guard: git -c or --config-env on include.path or includeIf.*.path pulls in config that sets core.hooksPath or that the guard cannot read in time, or runs beside other commands or a redirect, which would bypass the pre-push leak scan. ${DOCS}`,
  gitConfigUnresolved: `leak-guard: git -c or --config-env with a key or value the guard cannot read, before a command that runs hooks, may set core.hooksPath or include.path and would bypass the pre-push leak scan. Spell the config out, or drop it. ${DOCS}`,
  configProgram: `leak-guard: git -c or --config-env here may set a key whose value git runs as a program (core.pager, core.editor, core.sshCommand and the like), and the guard cannot read the key or the value. Write the config out literally, or drop it. ${DOCS}`,
  programEnv: `leak-guard: this line runs git and uses an environment variable git, man or less runs as a program (GIT_PAGER, PAGER, MANPAGER, GIT_EDITOR, EDITOR, GIT_SSH_COMMAND, LESS and the like) other than by reading it or by a plain literal NAME=value, so the guard cannot tell what git runs. Write the assignment as a literal prefix or export, or put the command that names the variable on a line without git. ${DOCS}`,
  gitValueSplits: `leak-guard: a git option or option value here is unquoted, and the shell may split it into several words, one of them an option such as -c core.hooksPath, so the guard cannot tell what git runs. Quote the value, as in git -C "$dir" fetch. ${DOCS}`,
  operatorExpansion: `leak-guard: this line holds a \${...} expansion with a quote, a nested expansion or a flag, or one with an operator beside a gh command, which the guard cannot read the way the shell will. Compute the value in an earlier Bash call, or write it out. ${DOCS}`,
  parenMixed: `leak-guard: this line mixes a parenthesized glob or group with a git or gh command, which the guard cannot read reliably. Put the command on a line of its own. ${DOCS}`,
  aliasQuotedArgs: `leak-guard: this git ! alias takes an argument the guard cannot read (an expansion, or words xargs feeds it), or reads one with a modifier, or one that is not a plain word, or "$@" in quotes with other than one argument, so the guard cannot tell what the shell runs. Run the command the alias stands for directly. ${DOCS}`,
  aliasHidden: `leak-guard: the command word is an expansion the line ties to git, so the guard cannot tell which alias lookup applies or what git runs. Write the command name out: git <subcommand>, not $cmd. ${DOCS}`,
  ghApiUnquoted: `leak-guard: this gh api call holds an unquoted expansion the shell may split into flags, such as -X or -f, so the guard cannot tell if it is a read. Quote the endpoint, as in gh api "repos/o/r/commits/$SHA/check-runs", or post a write with agent-chat gh-write -- api <args>. ${DOCS}`,
  ghApiRoute: `leak-guard: a gh api read with an argument the guard cannot resolve is allowed only alone on its line, beside assignments with literal values. Put the value in literally (gh api repos/o/r/commits/<sha>/check-runs), or run the gh api call on a line of its own with no pipe, redirect, $(...) or other command. ${DOCS}`,
  ghApiHost: `leak-guard: a gh api read with an argument the guard cannot resolve may go only to github.com, with no proxy variable. Drop the --hostname, GH_HOST or HTTPS_PROXY, HTTP_PROXY or ALL_PROXY setting, or put the value in literally. ${DOCS}`,
  ghConfigHome: `leak-guard: a gh call that sets GH_CONFIG_DIR, XDG_CONFIG_HOME or HOME may read a gh config that sends its requests through a socket of the config's choosing (http_unix_socket). Drop the setting. ${DOCS}`,
  nestedScript: `leak-guard: git runs a command here (rebase --exec, submodule foreach, bisect run or the like) that the guard cannot read. Write the command out literally. ${DOCS}`,
  writtenBody: `leak-guard: this command line writes a PR or issue body file and posts it, so the guard cannot scan a body that does not exist yet. ${HEREDOC_POST} Or write the file in one Bash call and post it in the next. ${DOCS}`,
  ghByPath: `leak-guard: gh called by path skips the agent's gh shim and the gh-write leak scan. Use bare gh for reads and agent-chat gh-write -- <gh args> for every GitHub write. ${DOCS}`,
  aliasWritten: `leak-guard: this command line writes git config and runs a git word that may be an alias, so the guard cannot tell what that alias will run. Write the config in one Bash call and run the alias in another. ${DOCS}`,
  ghAliasWritten: `leak-guard: this command line writes gh config and runs a gh word that may be an alias, so the guard cannot tell what that alias will run. Write the config in one Bash call and run the alias in another. ${DOCS}`,
  ghAliasEnv: `leak-guard: this command line sets GH_CONFIG_DIR, XDG_CONFIG_HOME or HOME and runs a gh word that may be an alias, so the guard cannot tell which config gh reads it from. Drop the setting. ${DOCS}`,
  ghAliasHidden: `leak-guard: a gh alias definition, a gh command word, or an argument passed to a gh alias holds a word or flag the guard cannot resolve or read, so it cannot tell what the alias runs. Write it out literally. ${DOCS}`,
  ghAliasUnreadable: `leak-guard: the guard cannot parse gh's config.yml, or a gh alias name holds a quoted or escaped space, so it cannot tell whether this gh command runs an alias. Fix the file so it is plain YAML with an aliases map of strings and names of plain words. ${DOCS}`,
  ghAliasUnread: `leak-guard: gh alias import, and gh alias set with - as the expansion, read aliases the guard does not check. Set each alias with gh alias set <name> '<expansion>' written out. ${DOCS}`,
  ghCloneHidden: `leak-guard: gh repo clone, gh repo fork or gh gist clone hands git clone a word after -- that the guard cannot resolve, which may be a -c, --config or --upload-pack option. Write it out literally. ${DOCS}`,
  ghExtension: `leak-guard: this gh command runs a gh extension, a program the guard cannot read. Run the commands it runs directly. ${DOCS}`,
  extProtocol: `leak-guard: this switches on git's ext:: transport, which runs a URL as a shell command: GIT_ALLOW_PROTOCOL listing ext on any line, or unset on a line that runs git, or git config setting protocol.allow or protocol.ext.allow to anything but never, or renaming a section into protocol. Leave the protocol list alone. ${DOCS}`,
  remoteUrlUnresolved: `leak-guard: this writes a git remote URL, URL helper or insteadOf rewrite (git clone's repository, git remote or git submodule add or set-url, git config remote.*.url, pushurl, vcs, submodule.*.url or url.*.insteadOf, or a section renamed into remote, url or submodule), or a config key or verb, that the guard cannot read, or passes git config, remote or submodule a word the shell may expand to none or several (an unquoted $X, "$@", a glob or a brace), and it may hide an ext:: URL a later git runs as a shell command. Write the URL and key out literally. ${DOCS}`,
  xargsPush: `leak-guard: git push run by xargs may take --no-verify from the words xargs reads, which the guard cannot see. Write the push out, or put -- before the words xargs adds, as in xargs git push origin --. ${DOCS}`,
  xargsWrapper: `leak-guard: xargs fills an option word of env, nice, timeout or another wrapper here, which may become any option, such as env -i, -u GIT_CONFIG_COUNT or -S with a command, so the guard cannot tell what runs. Write the wrapper's options out. ${DOCS}`,
  gitOptionUnmatched: `leak-guard: this git config, remote or submodule call has an option the guard cannot match to exactly one option git knows. git accepts any unique prefix of a long option, so the guard cannot tell which word is the key, URL or verb. Spell each option in full. ${DOCS}`,
  sshProgram: `leak-guard: this ssh, scp or sftp call has an option that runs a local program the guard never reads: an -o keyword such as ProxyCommand, LocalCommand or KnownHostsCommand, a -F config file other than /dev/null, scp or sftp -S or -D, or an option word the guard cannot read. Use -J for a jump host, or -F /dev/null. ${DOCS}`,
  shellStartupEnv: `leak-guard: this line sets or exports a variable a shell turns into code it runs (BASH_ENV, ENV, ZDOTDIR, an exported BASH_FUNC_*, SHELLOPTS, BASHOPTS, a prompt such as PS4 or PROMPT_COMMAND, FPATH and the like), which the guard never reads, and it may reach git or gh. Drop the setting, or put it on a line without git or gh. ${DOCS}`,
  gitExecPath: `leak-guard: this line sets GIT_EXEC_PATH or passes git --exec-path=<dir>, which makes git run its helper programs, hooks included, from a directory the guard never reads. Drop the setting. ${DOCS}`,
  templateDir: `leak-guard: this line sets GIT_TEMPLATE_DIR, passes git init, init-db or clone --template=<dir>, or sets init.templateDir by git -c, --config-env or git config, which makes git copy hooks and config from a directory the guard never reads. Drop the setting. ${DOCS}`,
  safeDirectory: `leak-guard: git -c, --config-env or git config here sets safe.directory, which makes git trust the config and hooks of a repository someone else owns, which the guard never reads. Drop the setting. ${DOCS}`,
} as const

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ENV_EDITS = new Set(['export', 'unset', 'declare', 'typeset', 'readonly', 'local'])
const PREFIX_WORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time'])
const PLAIN_WRAPPERS = new Set(['command', 'builtin', 'nohup', 'noglob', 'nocorrect', 'coproc'])
const OPTION_WRAPPERS = [
  'exec',
  'nice',
  'stdbuf',
  'ionice',
  'caffeinate',
  'timeout',
  'repeat',
  'xargs',
  'env',
  'sudo',
]
/** A getopt_long option table: the short letters that take a value, and each long name with whether it takes one. */
interface Getopt {
  shortValue: string
  long: Readonly<Record<string, boolean>>
}
// coreutils stdbuf: `+i:o:e:`.
const STDBUF_GETOPT: Getopt = {
  shortValue: 'ioe',
  long: { input: true, output: true, error: true, help: false, version: false },
}
// util-linux ionice: `+n:c:p:P:u:tVh`.
const IONICE_GETOPT: Getopt = {
  shortValue: 'cnpPu',
  long: {
    class: true,
    classdata: true,
    pid: true,
    pgid: true,
    uid: true,
    ignore: false,
    help: false,
    version: false,
  },
}
/** Every name unwrap or checkSimple acts on; a command that starts with another literal word runs nothing checked. */
const CHECKED_NAMES = new Set([
  ...PLAIN_WRAPPERS,
  ...OPTION_WRAPPERS,
  ...SHELLS,
  ...ENV_EDITS,
  ...SSH_PROGRAMS,
  ...['function', 'eval', 'git', 'gh', 'agent-chat', 'find'],
])
const XARGS_SHORT_VALUE = new Set('nILPdasEJRS')
const XARGS_LONG_VALUE = new Set([
  '--arg-file',
  '--delimiter',
  '--max-args',
  '--max-chars',
  '--max-procs',
  '--process-slot-var',
])
const XARGS_LONG_FLAG = new Set([
  '--null',
  '--eof',
  '--replace',
  '--max-lines',
  '--interactive',
  '--open-tty',
  '--no-run-if-empty',
  '--verbose',
  '--exit',
  '--show-limits',
  '--version',
  '--help',
])
// From sudo's getopt string `+Aa:BbC:c:D:Eeg:Hh::iKklNnPpR:r:SsT:t:U:u:Vv`.
const SUDO_SHORT_VALUE = new Set('aCcDgpRrTtUu')
const SUDO_LONG_VALUE = new Set([
  '--close-from',
  '--chdir',
  '--group',
  '--host',
  '--prompt',
  '--chroot',
  '--role',
  '--type',
  '--command-timeout',
  '--other-user',
  '--user',
  '--login-class',
])
const SUDO_LONG_FLAG = new Set([
  '--askpass',
  '--bell',
  '--background',
  '--preserve-env',
  '--edit',
  '--set-home',
  '--login',
  '--remove-timestamp',
  '--reset-timestamp',
  '--list',
  '--no-update',
  '--non-interactive',
  '--preserve-groups',
  '--stdin',
  '--shell',
  '--version',
  '--validate',
  '--help',
])

// `NAME=`, `NAME+=`, `NAME[idx]=` and `NAME[idx]+=` all assign: the shell reads the next word as the command.
// The lexer marks the `[` of a subscript as live, since it is a glob character elsewhere.
const ASSIGNMENT = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)(?:${LIVE}?\\[.*\\])?\\+?=`, 's')
const ASSIGNMENT_VALUE = new RegExp(`^[A-Za-z_][A-Za-z0-9_]*(?:${LIVE}?\\[.*\\])?\\+?=(.*)$`, 's')
const SUBSCRIPTED_OR_APPENDING = new RegExp(`^[A-Za-z_][A-Za-z0-9_]*(?:${LIVE}?\\[|\\+=)`)
// A word that opens a subscript and never closes it, as in `A[a b]=1 cmd`: no way to tell where the command starts.
const BROKEN_SUBSCRIPT = new RegExp(`^[A-Za-z_][A-Za-z0-9_]*${LIVE}?\\[[^\\]]*$`)
const assignedValue = (word: string): string => ASSIGNMENT_VALUE.exec(word)?.[1] ?? ''
const brokenAssignment = (word: string): boolean => BROKEN_SUBSCRIPT.test(word)
const isGitConfigVar = (name: string | undefined): boolean => name !== undefined && /^GIT_CONFIG/.test(name)
const NO_VERIFY = /^--no-veri(?:f|fy)?$/
const MENTIONS_GIT = /\b(?:git|gh)\b|GIT_CONFIG/
const NAMES_GH = /\bgh\b/

/**
 * `chdir` is set when a wrapper such as `env -C` runs the command in another directory.
 * `assigns` are the command's own `NAME=value` words, and a bare `NAME` that `env -u` unsets.
 */
type Unwrapped =
  | {
      words: string[]
      chdir?: boolean
      assigns: string[]
      fed?: Fed | undefined
      /** Commands that also run, each read as a command line of its own: find's later action clauses. */
      siblings?: Sibling[]
    }
  | { reason: string }

/** What the wrappers before a command have set up, carried to a command that runs beside it. */
interface Lead {
  assigns: readonly string[]
  chdir: boolean
  fed: Fed | undefined
}

/** A find clause read apart from the find's first, under the wrappers that came before that find. */
interface Sibling extends Lead {
  words: string[]
}

/**
 * xargs runs its command with words it reads: in place of each word holding the `replace` string,
 * and appended when `append` is set. A replace mode the guard cannot pin down sets both.
 */
interface Fed {
  replace?: string | undefined
  append: boolean
  /** A split option word may have put words of its own before the command. */
  hidden?: boolean
}

/** The words xargs adds, read as an unquoted `$@`: unreadable, and may be none or several. */
const XARGS_ARGS = LIVE + '$@'
/** A replace string the guard cannot read, which any word may hold. */
const ANY_WORD = ''
const BRACE_PAIR = LIVE + '{}'

/** Strips assignments and wrappers such as `env`, `command` and `nice` down to the command that runs. */
function unwrap(words: readonly string[], splits: readonly string[] = [], lead?: Lead): Unwrapped {
  let rest = words
  let at = 0
  let chdir = lead?.chdir ?? false
  let fed = lead?.fed
  // An xargs given a command whose wrappers leave none runs a command its input names, as `xargs nice` does.
  let fedCommand = false
  let siblings: Sibling[] | undefined
  const assigns = [...(lead?.assigns ?? [])]
  const done = (): Unwrapped =>
    fedCommand && at >= rest.length
      ? { reason: REASONS.hiddenCommand }
      : { words: rest.slice(at), chdir, assigns, fed, ...(siblings && { siblings }) }
  for (;;) {
    const head = rest[at]
    if (head === undefined) return done()
    // A command word xargs fills, behind any wrappers, is a command its input names.
    if (fed !== undefined && head.includes(XARGS_ARGS)) return { reason: REASONS.hiddenCommand }
    const name = path.basename(head)
    const assigned = ASSIGNMENT.exec(head)?.[1]
    const next = wrapperEnd(rest, at, name)
    if (brokenAssignment(head)) return { reason: REASONS.assignmentSubscript }
    if (fed !== undefined && next !== undefined && rest.slice(at + 1, next).some(w => w.includes(LIVE)))
      return { reason: REASONS.xargsWrapper }
    if (assigned !== undefined) {
      if (isGitConfigVar(assigned)) return { reason: REASONS.gitConfigEnv }
      assigns.push(head)
      at++
    } else if (PREFIX_WORDS.has(head)) at = dropOptions(rest, at + 1)
    else if (next !== undefined) at = next
    else if (name === 'xargs') {
      const after = dropXargsOptions(rest, at + 1, splits)
      if (after === undefined) return { reason: REASONS.xargsOption }
      at = after.at
      fedCommand ||= at < rest.length
      fed = fed === undefined ? after.fed : nestedFed(fed, after.fed)
      // Every wrapper and the command after this point parse the words as xargs fills them.
      const { replace } = fed
      if (replace !== undefined)
        rest = [...rest.slice(0, at), ...rest.slice(at).map(w => placeFed(w, replace))]
    } else if (name === 'find') {
      // Words xargs adds land among find's own, where one may be -exec.
      if (fed?.append === true || fed?.hidden === true) return { reason: REASONS.hiddenCommand }
      const run = findRun(rest, at)
      if (run === undefined) return done()
      const before: Lead = { assigns: [...assigns], chdir, fed }
      fed = fed === undefined ? FIND_FED : nestedFed(fed, FIND_FED)
      // A find inside a clause keeps the outer find's later clauses alongside its own.
      siblings = [
        ...(siblings ?? []),
        ...run.later.map(words => ({ ...before, words })),
        ...run.tail.map(words => ({ ...before, fed, words })),
      ]
      chdir ||= run.chdir
      rest = run.words.map(w => placeFed(w, '{}'))
      at = run.at
    } else if (name === 'sudo') {
      const after = dropSudoOptions(rest, at + 1)
      if (after === undefined) return { reason: REASONS.sudoOption }
      // sudo resets HOME, and -D, -R and -i move the cwd, so git may read another config and other aliases.
      chdir = true
      if (after.shell) {
        const script = rest.slice(after.at)
        // Words xargs adds, or an expansion sudo then escapes, may hold anything the shell reads, such as $IFS.
        if (fed !== undefined || script.some(word => word.includes(LIVE)))
          return { reason: REASONS.hiddenCommand }
        rest = sudoShell(script)
        at = 0
      } else at = after.at
    } else if (name === 'env') {
      const env = unwrapEnv(rest, at + 1, fed !== undefined)
      if ('reason' in env) return env
      ;({ words: rest, at } = env)
      chdir ||= env.chdir === true
      assigns.push(...env.assigns)
    } else return done()
  }
}

/** The words xargs runs: unwrap has put its replace words in place, and here it appends the rest. */
const stdinArgs = (words: readonly string[], fed: Fed | undefined): string[] => {
  const placed = fed?.append === true && words.length > 0 ? [...words, XARGS_ARGS] : [...words]
  return fed?.hidden === true ? [XARGS_ARGS, ...placed] : placed
}

/**
 * A word with each copy of the replace string swapped for the unreadable words, keeping the rest of it
 * readable, as in the script of `sh -c 'git push {} --no-verify'`. A replace string the guard cannot read may be anywhere.
 */
function placeFed(word: string, replace: string): string {
  if (replace === ANY_WORD) return XARGS_ARGS
  const pattern = [...replace].map(c => `${LIVE}?${c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')}`).join('')
  return word.replace(new RegExp(pattern, 'g'), () => XARGS_ARGS)
}

/** find fills each `{}` in an action clause with a path the guard cannot read, and appends nothing. */
const FIND_FED: Fed = { replace: '{}', append: false }

/**
 * The command a `find` at `at` runs: its first action clause, with every `later` clause as a find of its
 * own to check apart. A word the guard cannot read may expand to `-exec`, or to a `;` that ends a clause
 * early, so the words from the first one on are also checked as a command, the `tail`. `chdir` is set
 * when the command runs in each found file's directory. Undefined when find runs nothing.
 */
function findRun(
  rest: readonly string[],
  at: number,
): { words: string[]; at: number; chdir: boolean; later: string[][]; tail: string[][] } | undefined {
  const { clauses, hiddenAt } = findClauses(rest, at + 1)
  const alone = (clause: FindClause): string[] => [rest[at] as string, clause.action, ...clause.words, ';']
  const inClause = clauses.flatMap(c => c.words.flatMap((w, i) => (unreadable(w) ? [c.at + i] : [])))
  const tailAt = Math.min(hiddenAt ?? Infinity, inClause[0] ?? Infinity)
  const tail = tailAt < Infinity ? [rest.slice(tailAt).map(w => placeFed(w, '{}'))] : []
  const [first, ...later] = clauses
  if (first !== undefined) {
    const chdir = first.action === '-execdir' || first.action === '-okdir'
    return { words: [...first.words], at: 0, chdir, later: later.map(alone), tail }
  }
  return tailAt < Infinity ? { words: [...rest], at: tailAt, chdir: false, later: [], tail: [] } : undefined
}

/** A word holding an expansion, other than the bare `{}` the shell leaves alone. */
const unreadable = (word: string): boolean => word.replaceAll(BRACE_PAIR, '{}').includes(LIVE)

/** xargs running xargs: the outer one's words reach the inner command too, wherever the guard cannot say. */
const nestedFed = (outer: Fed, inner: Fed): Fed => ({
  append: true,
  replace: outer.replace === undefined && inner.replace === undefined ? undefined : ANY_WORD,
  hidden: outer.hidden === true || inner.hidden === true,
})

/** Where the command after a wrapper and its options starts; undefined when `name` is no such wrapper. */
function wrapperEnd(words: readonly string[], at: number, name: string): number | undefined {
  if (PLAIN_WRAPPERS.has(name)) return dropOptions(words, at + 1)
  if (name === 'exec') return dropOptions(words, at + 1, ['-a'])
  if (name === 'nice') return dropOptions(words, at + 1, ['-n'])
  if (name === 'stdbuf') return dropGetopt(words, at + 1, STDBUF_GETOPT)
  if (name === 'ionice') return dropGetopt(words, at + 1, IONICE_GETOPT)
  if (name === 'caffeinate') return dropOptions(words, at + 1, ['-t', '-w'])
  if (name === 'timeout' || name === 'repeat') return dropOptions(words, at + 1, ['-s', '-k']) + 1
  return undefined
}

/** The index of the first word from `i` on that is not an option or an option's value. */
function dropOptions(words: readonly string[], i: number, withValue: readonly string[] = []): number {
  while (i < words.length && (words[i] as string).startsWith('-') && words[i] !== '-') {
    i += withValue.includes(words[i] as string) ? 2 : 1
  }
  return Math.min(i, words.length)
}

/**
 * The index of the command after a getopt_long wrapper's options, read as getopt reads them: an unambiguous long-name
 * prefix, `--name=value`, and a short cluster whose value letter takes the rest of the word or the next one.
 * A word the guard cannot read stops the scan there, so it is read as the command.
 */
function dropGetopt(words: readonly string[], i: number, spec: Getopt): number {
  while (i < words.length) {
    const word = words[i] as string
    if (word === '--') return i + 1
    if (!word.startsWith('-') || word === '-') return i
    const width = word.startsWith('--')
      ? longOptionWidth(word.slice(2), spec)
      : shortClusterWidth(word.slice(1), spec)
    if (width === undefined) return i
    i += width
  }
  return words.length
}

/** How many words a long option takes: 2 when it needs the next word as its value, 1 otherwise. */
function longOptionWidth(body: string, spec: Getopt): number | undefined {
  const eq = body.indexOf('=')
  const name = eq < 0 ? body : body.slice(0, eq)
  if (name.includes(LIVE)) return undefined
  const names = Object.keys(spec.long)
  const matches = name in spec.long ? [name] : names.filter(n => n.startsWith(name))
  // An ambiguous prefix whose names all take a value still takes one; getopt refuses any other.
  const takesValue = matches.length > 0 && matches.every(n => spec.long[n] === true)
  return takesValue && eq < 0 ? 2 : 1
}

/** How many words a short cluster takes: a value letter ends it, taking the next word when nothing follows it. */
function shortClusterWidth(cluster: string, spec: Getopt): number | undefined {
  for (let k = 0; k < cluster.length; k++) {
    if (cluster[k] === LIVE) return undefined
    if (spec.shortValue.includes(cluster[k] as string)) return k === cluster.length - 1 ? 2 : 1
  }
  return 1
}

/** What one xargs option sets about how it feeds its command. */
interface FeedOption {
  replace?: string | undefined
  /** The option may make xargs append what it reads: a batch size, or BSD's -J. */
  appends?: boolean
}

const BATCH_LONG = new Set(['--max-args', '--max-lines'])

/**
 * Returns where the command xargs runs starts and how it feeds it, or undefined on a long option this guard does not know.
 * GNU xargs drops a replace string on a later -n, -L or -l and appends instead; the guard does not track the order and reads both.
 * An option word or value the shell may split could hold another option, such as -I--, so the feed mode is then unknown.
 * Past a split the command is read like a hidden command word, unless a later word may start a command or reach git.
 */
function dropXargsOptions(
  words: readonly string[],
  i: number,
  splits: readonly string[],
): { at: number; fed: Fed } | undefined {
  let replace: string | undefined
  let appends = false
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a === '--') return { at: i + 1, fed: feed(replace, appends) }
    const option =
      !a.startsWith('-') || a === '-'
        ? undefined
        : a.startsWith('--')
          ? longFeed(a)
          : clusterFeed(a, words[i + 1])
    const width = !a.startsWith('-') ? 0 : a.startsWith('--') ? longValueWords(a) : clusterValueWords(a)
    const splitting = words.slice(i, i + 1 + width).some(word => mayResplit(word, splits))
    const unread = a.replaceAll(BRACE_PAIR, '{}').includes(LIVE) && option?.replace === undefined
    // An expansion here may be an option such as -I--, so the guard cannot tell how xargs feeds the command.
    if (splitting || unread) return splitFeed(words, i, i + 1 + width, splits, replace)
    if (!a.startsWith('-') || a === '-') break
    if (option === undefined) return undefined
    replace = option.replace ?? replace
    appends ||= option.appends === true
    i += width
  }
  return { at: Math.min(i, words.length), fed: feed(replace, appends) }
}

/** Every word may be fed, and more appended: where the guard cannot read xargs' options. */
const UNKNOWN_FEED: Fed = { replace: ANY_WORD, append: true }

/**
 * The feed past an xargs option word the guard cannot read, at `i`: the options before it and from `after` on, with the
 * split's words read as put before the command. The split may move where xargs' options end, so any later word, an
 * option value included, that may start a command or reach git keeps every word unknown.
 */
function splitFeed(
  words: readonly string[],
  i: number,
  after: number,
  splits: readonly string[],
  replace: string | undefined,
): { at: number; fed: Fed } | undefined {
  const rest = dropXargsOptions(words, after, splits)
  if (rest === undefined) return undefined
  const unknown = { at: i, fed: UNKNOWN_FEED }
  if (rest.fed === UNKNOWN_FEED || rest.at >= words.length) return unknown
  const later = words.slice(after).map(word => word.replaceAll(BRACE_PAIR, '{}'))
  if (later.some(word => mayStartCommand(word) || wordMayBeGit(word))) return unknown
  return { at: rest.at, fed: { replace: rest.fed.replace ?? replace, append: true, hidden: true } }
}

/** A word the shell may split into several; xargs' `{}` is a literal, not a brace list. */
const mayResplit = (word: string, splits: readonly string[]): boolean =>
  word.replaceAll(BRACE_PAIR, '{}').includes(LIVE) && expandsToWords(word, splits)

const feed = (replace: string | undefined, appends: boolean): Fed => ({
  replace,
  append: replace === undefined || appends,
})

function longFeed(option: string): FeedOption | undefined {
  const name = option.split('=')[0] as string
  if (!XARGS_LONG_VALUE.has(name) && !XARGS_LONG_FLAG.has(name)) return undefined
  if (name === '--replace')
    return { replace: option.includes('=') ? replaceString(option.slice(name.length + 1)) : '{}' }
  return { appends: BATCH_LONG.has(name) }
}

const longValueWords = (option: string): number =>
  XARGS_LONG_VALUE.has(option.split('=')[0] as string) && !option.includes('=') ? 1 : 0

/** What a short-flag cluster sets: a replace string (`-I R`, `-J R`, or `-i[R]`, whose bare form means `{}`), or a batch size. */
function clusterFeed(cluster: string, next: string | undefined): FeedOption {
  for (let k = 1; k < cluster.length; k++) {
    const letter = cluster[k] as string
    const glued = cluster.slice(k + 1)
    // BSD -J appends when no word is exactly the replace string, so only GNU's -I is known never to append.
    if (letter === 'I' || letter === 'J')
      return { replace: replaceString(glued === '' ? (next ?? '') : glued), appends: letter === 'J' }
    if (letter === 'i') return { replace: glued === '' ? '{}' : replaceString(glued) }
    if ('nLl'.includes(letter)) return { appends: true }
    if (XARGS_SHORT_VALUE.has(letter) || letter === 'e') return {}
  }
  return {}
}

/** A replace string as xargs gets it; one the shell expands may be anything, so any word may hold it. */
const replaceString = (marked: string): string => {
  const plain = marked.replaceAll(BRACE_PAIR, '{}')
  return plain.includes(LIVE) ? ANY_WORD : plain
}

/** Where the command sudo runs starts, and whether -s, -i, --shell or --login hand it to a shell instead. */
interface SudoRun {
  at: number
  shell: boolean
}

interface SudoOption {
  width: number
  shell: boolean
}

const SUDO_SHELL_LONG = new Set(['--shell', '--login'])

/**
 * The command sudo runs, or undefined on a long option this guard does not know, an ambiguous -h,
 * or an option word the shell expands, which may be any option.
 */
function dropSudoOptions(words: readonly string[], i: number): SudoRun | undefined {
  let shell = false
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a === '--') return { at: i + 1, shell }
    if (!a.startsWith('-') || a === '-') break
    if (a.includes(LIVE)) return undefined
    const option = a.startsWith('--') ? sudoLongOption(a) : sudoCluster(a, i + 1 < words.length)
    if (option === undefined) return undefined
    shell ||= option.shell
    i += option.width
  }
  return { at: Math.min(i, words.length), shell }
}

function sudoLongOption(option: string): SudoOption | undefined {
  const name = option.split('=')[0] as string
  if (!SUDO_LONG_VALUE.has(name) && !SUDO_LONG_FLAG.has(name)) return undefined
  return {
    width: SUDO_LONG_VALUE.has(name) && !option.includes('=') ? 1 : 0,
    shell: SUDO_SHELL_LONG.has(name),
  }
}

/**
 * A sudo short-flag cluster takes the next word only when its first value letter ends it; a glued -h takes the rest.
 * A bare -h before another word is --help in some sudo versions and --host with that word in others, so it is undefined.
 */
function sudoCluster(cluster: string, hasNext: boolean): SudoOption | undefined {
  let shell = false
  for (let k = 1; k < cluster.length; k++) {
    const letter = cluster[k] as string
    const last = k === cluster.length - 1
    if (SUDO_SHORT_VALUE.has(letter)) return { width: last ? 1 : 0, shell }
    if (letter === 'h') return last && hasNext ? undefined : { width: 0, shell }
    shell ||= letter === 's' || letter === 'i'
  }
  return { width: 0, shell }
}

/** sudo -s or -i runs `shell -c` on its words joined, each character but alnum, _, - and $ escaped. */
const sudoShell = (words: readonly string[]): string[] =>
  words.length === 0 ? ['sh'] : ['sh', '-c', words.map(w => w.replace(/[^A-Za-z0-9_$-]/g, '\\$&')).join(' ')]

/** A short-flag cluster takes the next word only when its first value letter ends it. */
function clusterValueWords(cluster: string): number {
  for (let k = 1; k < cluster.length; k++) {
    if (XARGS_SHORT_VALUE.has(cluster[k] as string)) return k === cluster.length - 1 ? 1 : 0
    if ('ile'.includes(cluster[k] as string)) return 0
  }
  return 0
}

/** The words env runs and where in them its command starts; `-S` splits its value into new words. */
type EnvRun =
  { words: readonly string[]; at: number; chdir?: boolean; assigns: string[] } | { reason: string }

const EXPANDS = new RegExp(`${LIVE}[$\`]`)

/** The value of an `env -S` / `--split-string` word, alone or ending an option cluster like `-vS`, and how many words it takes. */
function splitString(a: string, next: string | undefined): { value: string; width: number } | undefined {
  if (a === '--split-string') return { value: next ?? '', width: 2 }
  const glued = /^--split-string=(.*)/s.exec(a)?.[1]
  if (glued !== undefined) return { value: glued, width: 1 }
  const cluster = /^-[a-zA-Z]*S(.*)$/s.exec(a)
  if (cluster === null) return undefined
  return cluster[1] === '' ? { value: next ?? '', width: 2 } : { value: cluster[1] as string, width: 1 }
}

// env splits the value by its own rules: a backslash escapes, and it honours more blanks than the shell does.
const ENV_SPLIT_ESCAPES = /[\\]|[^\S \t]/

const ENV_VALUE_OPTIONS_FED = new Set(['-u', '--unset', '-C', '--chdir', '-P', '-S', '--split-string'])
const nameOf = (word: string): string => word.split('=')[0] as string

/**
 * Behind xargs, an env word the guard cannot read may become any option: -i, -u GIT_CONFIG_COUNT,
 * or -S with a command. Like an unreadable xargs option, it fails closed.
 */
function fedEnvWord(a: string, next: string | undefined): string | undefined {
  if (!a.startsWith('-'))
    return a.includes('=') && nameOf(a).includes(LIVE) ? REASONS.gitConfigEnv : undefined
  const value = ENV_VALUE_OPTIONS_FED.has(a) ? (next ?? '') : ''
  if (!a.includes(LIVE) && !value.includes(LIVE)) return undefined
  return /^(?:-u|--unset)/.test(a) ? REASONS.gitConfigEnv : REASONS.xargsWrapper
}

function unwrapEnv(args: readonly string[], i: number, fed = false): EnvRun {
  let chdir = false
  const assigns: string[] = []
  for (; i < args.length; i++) {
    const a = args[i] as string
    const fedReason = fed ? fedEnvWord(a, args[i + 1]) : undefined
    if (fedReason !== undefined) return { reason: fedReason }
    const unset =
      a === '-u' || a === '--unset' ? args[++i] : (/^-u(.+)/.exec(a)?.[1] ?? /^--unset=(.*)/.exec(a)?.[1])
    if (isGitConfigVar(unset)) return { reason: REASONS.gitConfigEnv }
    if (unset !== undefined) {
      assigns.push(unset)
      continue
    }
    if (a === '-' || a === '--ignore-environment' || /^-[^-]*i/.test(a)) return { reason: REASONS.envClear }
    const split = splitString(a, args[i + 1])
    if (split !== undefined) {
      if (EXPANDS.test(split.value) || ENV_SPLIT_ESCAPES.test(split.value))
        return { reason: REASONS.hiddenCommand }
      const words = [...(parseShell(split.value)[0]?.marked ?? []), ...args.slice(i + split.width)]
      const inner = unwrapEnv(words, 0, fed)
      if ('reason' in inner) return inner
      return { ...inner, chdir: chdir || inner.chdir === true, assigns: [...assigns, ...inner.assigns] }
    }
    chdir ||= /^(?:-C|--chdir)/.test(a)
    if (a === '-C' || a === '--chdir' || a === '-P') i++
    else if (a === '--') {
      // env still reads NAME=value operands after `--`.
      let at = i + 1
      for (; at < args.length && (args[at] as string).includes('='); at++) {
        const operand = args[at] as string
        if (isGitConfigVar(nameOf(operand)) || (fed && nameOf(operand).includes(LIVE)))
          return { reason: REASONS.gitConfigEnv }
        assigns.push(operand)
      }
      return { words: args, at, chdir, assigns }
    } else if (brokenAssignment(a)) return { reason: REASONS.assignmentSubscript }
    else if (!a.startsWith('-') && !a.includes('=')) break
    else if (isGitConfigVar(a.split('=')[0])) return { reason: REASONS.gitConfigEnv }
    else if (!a.startsWith('-')) assigns.push(a)
  }
  return { words: args, at: Math.min(i, args.length), chdir, assigns }
}

function checkEnvEdit(args: readonly string[]): string | undefined {
  const names = args.filter(a => !a.startsWith('-')).map(a => ASSIGNMENT.exec(a)?.[1] ?? a)
  return names.some(isGitConfigVar) ? REASONS.gitConfigEnv : undefined
}

function overridesGuard(kv: string | undefined): boolean {
  const key = (kv ?? '').split('=')[0]?.toLowerCase() ?? ''
  return key === 'core.hookspath' || key.startsWith('alias.')
}

function configValue(args: readonly string[], i: number): { kv: string | undefined; next: number } {
  const a = args[i] as string
  if (a === '-c' || a === '--config-env') return { kv: args[i + 1], next: i + 2 }
  if (a.startsWith('--config-env=')) return { kv: a.slice('--config-env='.length), next: i + 1 }
  if (a.startsWith('-c')) return { kv: a.slice(2), next: i + 1 }
  return { kv: undefined, next: i + (GIT_VALUE_OPTS.has(a) ? 2 : 1) }
}

export function checkGit(args: readonly string[]): string | undefined {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const { kv, next } = configValue(args, i)
    if (overridesGuard(kv)) return REASONS.gitConfig
    const trust = kv === undefined ? undefined : trustKey(kv.split('=')[0] as string)
    if (trust !== undefined) return REASONS[trust]
    if (execPathOption(args[i] as string)) return REASONS.gitExecPath
    i = next
  }
  const [sub, ...rest] = args.slice(i)
  const opts = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  if (sub === 'push') return opts.some(a => NO_VERIFY.test(a)) ? REASONS.noVerify : undefined
  if (sub === 'config') return configWritesGuard(rest)
  return undefined
}

/** A `git` command as the alias check needs it: its words and the variables it sets for itself. */
interface GitRun {
  resolved: readonly (string | undefined)[]
  args: readonly string[]
  /** `args` with LIVE before each character the shell expands. */
  marked: readonly string[]
  assigns: readonly string[]
  cmd: SimpleCommand
  /** The command word is git, not an expansion that may be git. */
  literal: boolean
  /** The command word is git, or an expansion the line ties to git. */
  tied: boolean
}

function gitRun(
  marked: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  literal: boolean,
  tied = literal,
): GitRun {
  const resolved = marked.map(word => resolveWord(word, cmd, ctx, scope))
  return { resolved, args: marked.map(unmark), marked, assigns, cmd, literal, tied }
}

const NAMES_GIT = /\bgit\b/
const VARIABLE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g
// Positional and special parameters, REPLY, argv, reply and MAPFILE are set without naming them.
const UNNAMED_SET = /\$\{?(?:[0-9*@]|(?:_|REPLY|argv|reply|MAPFILE)(?![A-Za-z0-9_]))/
// `${!y}`, a zsh flag such as `${(P)y}` or `${=x}`, and zsh's bare `$=x`, `$~x` and `$^x` hide the name.
const HIDDEN_NAME = /\$\{(?![A-Za-z_])|\$[=~^]/
// `${NAME:-default}` and its kin read NAME without assigning it, unlike `${NAME:=default}`.
const READ_ONLY_REF = new RegExp(`\\$\\{${NAME}(?=:?[-+?]|[#%/])`, 'g')

/** An expanded command word that names git, runs a substitution, or reads a variable the line may set or the hook holds as git. */
function tiedToGit(head: string, cmd: SimpleCommand, ctx: GuardContext, scope: Scope): boolean {
  const raw = unmark(head)
  if (NAMES_GIT.test(raw.replace(QUOTING, '')) || mayExpandToGit(raw)) return true
  if (UNNAMED_SET.test(raw) || HIDDEN_NAME.test(raw)) return true
  if (cmd.substitutions.some(sub => head.includes(LIVE + sub.raw))) return true
  const said = scope.said.replace(READ_ONLY_REF, ' ')
  const names = [...raw.matchAll(VARIABLE)].map(match => match[1] as string)
  return names.some(name => mentions(said, name) || NAMES_GIT.test(ctx.env[name] ?? ''))
}

/** A lookup the guard cannot make denies where the command is git or an expansion the line ties to git (TP-613). */
const unsure = (run: GitRun): string | undefined =>
  run.tied ? (run.literal ? REASONS.aliasEnv : REASONS.aliasHidden) : undefined

/** The one boundary every command that is or may be git passes: git's own options, the config they include, then its alias. */
function checkGitRun(run: GitRun, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  return (
    checkGit(run.args) ??
    checkUnresolvedConfig(run) ??
    checkInclude(run, ctx, scope, depth) ??
    checkNestedScripts(run, ctx, scope, depth) ??
    checkPrograms(run, ctx, scope, depth) ??
    checkExtEnablers(run, scope) ??
    checkTrustWrites(run, scope) ??
    checkFedPush(run, scope) ??
    checkAlias(run, ctx, scope, depth)
  )
}

/** git push options that take no value, so a `--` after them ends the options. */
const PUSH_FLAGS = new Set(
  '-u --set-upstream -f --force -n --dry-run -q --quiet -v --verbose --all --tags --atomic --follow-tags --porcelain --progress --no-progress --prune'.split(
    ' ',
  ),
)

/**
 * A `git push` that xargs feeds words may take `--no-verify` from them (CC-1117), unless git's own option
 * parsing ends at a `--` first. An option that may take a value, or a word the guard cannot read, may swallow that `--`.
 */
function checkFedPush(run: GitRun, scope: Scope): string | undefined {
  const at = subcommandAt(run, gitOptions(run.args, scope.cwd, scope.gitParams))
  if (
    at < 0 ||
    run.resolved[at] !== 'push' ||
    !run.marked.slice(at + 1).some(word => word.includes(XARGS_ARGS))
  )
    return undefined
  for (const word of run.resolved.slice(at + 1)) {
    if (word === '--') return undefined
    if (word === undefined || (word.startsWith('-') && !PUSH_FLAGS.has(word))) return REASONS.xargsPush
  }
  return REASONS.xargsPush
}

/**
 * Each value git runs as a program (TP-636), checked as a command line of its own: a `-c` config
 * value and an `ext::` transport payload. git passes its `-c` options on to each, so an include on
 * this git is a deny whatever the value holds. Program env vars are closed by `checkProgramEnvLine`.
 */
function checkPrograms(run: GitRun, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  const config = configPrograms(run.resolved, run.marked, run.cmd.splits)
  const options = gitOptions(run.args, scope.cwd, scope.gitParams)
  const ext = extPrograms(run.resolved, run.marked, run.cmd.splits, subcommandAt(run, options))
  if (config === undefined || ext.unreadable) return run.tied ? REASONS.configProgram : undefined
  const scripts = [...config, ...ext.scripts]
  const extOn = ext.enabled && run.tied ? REASONS.configProgram : undefined
  if (scripts.length === 0) return extOn
  const params = options === UNSURE_CALL ? scope.gitParams : options.params
  if (includesConfig(params)) return REASONS.includePath
  const inner: Scope = { ...scope, cwd: undefined, env: undefined, gitParams: params }
  for (const script of scripts) {
    const reason = checkAt(script, ctx, inner, depth + 1)
    if (reason !== undefined) return reason
  }
  return extOn
}

/** Where git's subcommand sits; past an option the guard cannot place, the first word that is not an option. */
const subcommandAt = (run: GitRun, options: ReturnType<typeof gitOptions>): number =>
  options === UNSURE_CALL ? run.resolved.findIndex(w => w !== undefined && !w.startsWith('-')) : options.at

/** A `git config`, `git remote` or `git clone` write that switches on `ext::` or hides a URL a later git may run (TP-2371, TP-2444). */
function checkExtEnablers(run: GitRun, scope: Scope): string | undefined {
  if (!run.tied) return undefined
  const at = subcommandAt(run, gitOptions(run.args, scope.cwd, scope.gitParams))
  const words = { resolved: run.resolved, written: run.args, marked: run.marked, splits: run.cmd.splits }
  const enabler = extEnablerWrite(words, at)
  if (enabler === 'protocol') return REASONS.extProtocol
  if (enabler === 'option') return REASONS.gitOptionUnmatched
  return enabler === 'url' ? REASONS.remoteUrlUnresolved : undefined
}

/** A `git config` write, or a `git init` or `git clone` template, that sets a trust input (TP-2376). */
function checkTrustWrites(run: GitRun, scope: Scope): string | undefined {
  if (!run.tied) return undefined
  const at = subcommandAt(run, gitOptions(run.args, scope.cwd, scope.gitParams))
  const sub = run.resolved[at]
  const args = { resolved: run.resolved.slice(at + 1), written: run.args.slice(at + 1) }
  if (sub === 'config') {
    const trust = trustConfigWrite(args)
    return trust === 'option' ? REASONS.gitOptionUnmatched : trust && REASONS[trust]
  }
  // An unmatched option makes git itself refuse; an unread word naming a template stays the env gap TP-2444 accepts.
  return sub !== undefined && templateOption(sub, args) === true ? REASONS.templateDir : undefined
}

const unresolvedReason = (run: GitRun): string =>
  hasSplittableOption(run.resolved, run.marked, run.cmd.splits)
    ? REASONS.gitValueSplits
    : REASONS.gitConfigUnresolved

const checkUnresolvedConfig = (run: GitRun): string | undefined =>
  hasUnreadableConfig(run.resolved, run.marked, run.cmd.splits)
    ? unresolvedReason(run)
    : hasOptionAlternation(run.marked, run.cmd.splits, run.resolved)
      ? REASONS.noVerify
      : undefined

const MENTIONS_INCLUDE = /include/i
const DESCRIPTOR_COPY = /\d*[<>]&(?:\d+|-)(?![\w./])/g

/** The line is this one git command alone: a substitution counts as a command, and a heredoc as a redirect. */
function soleCommand(scope: Scope, depth: number): boolean {
  const cmds = parseShell(scope.line)
  if (depth > 0 || cmds.length !== 1 || cmds[0]?.after !== '') return false
  return !/[<>]/.test(scope.line.replace(DESCRIPTOR_COPY, ''))
}

/** Reads the config files the command's own `-c include.path` and `includeIf.*.path` pull in, where it runs. */
function checkInclude(run: GitRun, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  if (!run.args.some(arg => MENTIONS_INCLUDE.test(arg))) return undefined
  const cannotRead = run.literal || NAMES_GIT.test(scope.said) ? REASONS.includePath : undefined
  const options = gitOptions(run.resolved, scope.cwd)
  if (options === UNSURE_CALL || !options.sure) return cannotRead
  if (!includesConfig(options.params)) return undefined
  if (!soleCommand(scope, depth)) return REASONS.includePath
  const env = aliasEnv(run, configEnvVars(options.params), ctx, scope)
  if (options.dir === undefined || env === undefined) return cannotRead
  return ctx.readIncludedHooksPath(options.dir, gitGlobals(options), env) ? REASONS.includePath : undefined
}

/** A span's text as git hands it on: one word as written, several quoted and joined like argv. */
function scriptText(span: ScriptSpan, resolved: readonly (string | undefined)[]): string | undefined {
  const words = resolved.slice(span.from, span.to)
  if (words.includes(undefined)) return undefined
  if (words.length === 1) return words[0]?.slice(span.offset)
  return (words as string[]).map(quoted).join(' ')
}

/**
 * Each command git runs for its subcommand (TP-634), checked as a command line of its own. git
 * passes its `-c` options on to it, and the command may write an include file before git reads it.
 */
function checkNestedScripts(run: GitRun, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  const options = gitOptions(run.args, scope.cwd, scope.gitParams)
  if (options === UNSURE_CALL) return undefined
  const spans = gitScripts(run.args, options.at)
  if (spans.length === 0) return undefined
  if (includesConfig(options.params)) return REASONS.includePath
  if (hasUnreadableOption(run.resolved, run.marked, run.cmd.splits)) return unresolvedReason(run)
  const inner: Scope = { ...scope, cwd: undefined, env: undefined, gitParams: options.params }
  for (const span of spans) {
    const script = scriptText(span, run.resolved)
    const reason =
      script === undefined
        ? run.tied
          ? REASONS.nestedScript
          : undefined
        : checkAt(script, ctx, inner, depth + 1)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** A git config file path, or `git config` on an alias or include key, anywhere on the line (TP-607). */
const WRITES_CONFIG = [
  /\bgit\/(?:\S*\/)?config(?:\.worktree)?\b|\.gitconfig\b/,
  /(?:^|[\s;&|(`'"])config\s[^\n;&|]*\b(?:alias|include(?:if)?)\./im,
]

/** Whether the line names `name` as a whole word; `GIT_CONFIG` also matches every `GIT_CONFIG_*`. */
const mentions = (said: string, name: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_])${name}${name === 'GIT_CONFIG' ? '[A-Za-z0-9_]*' : ''}(?![A-Za-z0-9_])`).test(
    said,
  )

/** What git's config env is for this command over the hook's; undefined when the guard cannot tell. */
function aliasEnv(
  run: GitRun,
  vars: readonly string[],
  ctx: GuardContext,
  scope: Scope,
): Overrides | undefined {
  const set = new Map(scope.exports)
  for (const word of run.assigns) {
    const name = ASSIGNMENT.exec(word)?.[1]
    const value =
      name === undefined
        ? undefined
        : SUBSCRIPTED_OR_APPENDING.test(word)
          ? UNSURE
          : (resolveWord(assignedValue(word), run.cmd, ctx, scope) ?? UNSURE)
    set.set(name ?? word, value)
  }
  const env: Record<string, string | undefined> = {}
  for (const name of [...CONFIG_ENV, ...vars]) {
    if (!set.has(name) && (scope.env === undefined || mentions(scope.said, name))) return undefined
    const value = set.get(name)
    if (value === UNSURE) return undefined
    if (set.has(name)) env[name] = value
  }
  return env
}

/** The scope a `!` alias body runs in: git exports its env, `--git-dir` and its `-c` options to it. */
const aliasShell = (scope: Scope, call: GitCall, env: Overrides, runsIn: string): Scope => ({
  ...scope,
  cwd: runsIn,
  exports: new Map([...scope.exports, ...Object.entries(env), ...Object.entries(call.dirEnv)]),
  gitParams: call.params,
})

/** Re-checks a `!` alias as the shell command git runs, with the words after the alias as its arguments. */
function checkShellAlias(
  run: GitRun,
  call: GitCall,
  shell: Scope,
  body: string,
  ctx: GuardContext,
  depth: number,
): string | undefined {
  // The body takes the words as the shell hands them over, so one the guard cannot resolve (an expansion,
  // or xargs' stdin) may be any flag, such as --no-verify (CC-1117).
  const words = run.resolved.slice(call.at + 1)
  const rest = words.filter((word): word is string => word !== undefined)
  // A `!` body passes the include to every git it runs and may write the file before one reads it.
  if (includesConfig(call.params)) return REASONS.includePath
  if (rest.length < words.length || fillsUnsafely(body, rest)) return REASONS.aliasQuotedArgs
  return checkAt(shellAlias(body, rest), ctx, shell, depth + 1)
}

/** Re-checks `git <alias> <rest>` as what the alias expands to, read where and how the command runs. */
function checkAlias(run: GitRun, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  const call = gitCall(run.resolved, scope.cwd, scope.gitParams)
  if (call === undefined) return undefined
  if (WRITES_CONFIG.some(pattern => pattern.test(scope.said)))
    return run.literal || NAMES_GIT.test(scope.said) ? REASONS.aliasWritten : undefined
  if (call === UNSURE_CALL) return unsure(run)
  const env = aliasEnv(run, call.vars, ctx, scope)
  if (env === undefined) return unsure(run)
  const alias = ctx.readAlias(call.sub, call.dir, call.globals, env)
  if (alias === undefined) return undefined
  if (scope.aliases >= MAX_ALIASES) return REASONS.aliasDepth
  const inner = { ...scope, aliases: scope.aliases + 1 }
  if (alias.value.startsWith('!'))
    return checkShellAlias(
      run,
      call,
      aliasShell(inner, call, env, alias.runsIn),
      alias.value.slice(1),
      ctx,
      depth,
    )
  const value = splitAlias(alias.value)
  if (value === undefined) return undefined
  // The words around the alias keep their marks, so an expansion or xargs' stdin stays unreadable (CC-1117).
  const around = <T extends string | undefined>(words: readonly T[]): (T | string)[] => [
    ...words.slice(0, call.at),
    ...value,
    ...words.slice(call.at + 1),
  ]
  return checkGitRun(
    {
      ...run,
      resolved: around(run.resolved),
      args: around(run.args),
      marked: around(run.marked),
      literal: true,
      tied: true,
    },
    ctx,
    inner,
    depth,
  )
}

function configWritesGuard(args: readonly string[]): string | undefined {
  const lower = args.map(a => a.toLowerCase())
  if (lower.some(a => a.includes('--no-veri'))) return REASONS.configWrite
  const key = lower.indexOf('core.hookspath')
  if (key < 0) return undefined
  const unsets = lower.some(a => a === 'unset' || a.startsWith('--unset'))
  return unsets || key < args.length - 1 ? REASONS.configWrite : undefined
}

interface Text {
  label: string
  text: string
}

interface BodyFile {
  label: string
  file: string
}

interface Sources {
  inline: Text[]
  files: BodyFile[]
}

type Texts = { texts: Text[] } | { reason: string }

function readAt(file: string, ctx: GuardContext, scope: Scope): string | undefined {
  if (path.isAbsolute(file)) return ctx.readFile(file)
  return scope.cwd === undefined ? undefined : ctx.readFile(`${scope.cwd}/${file}`)
}

/** What a quoted `$(cat file)` or `$(cat <<'EOF')` prints; undefined for any other substitution. */
function printedBy(sub: Substitution, ctx: GuardContext, scope: Scope): string | undefined {
  const [cat, ...others] = sub.commands
  if (!sub.quoted || cat === undefined || others.length > 0 || cat.marked[0] !== 'cat') return undefined
  const files = cat.marked.slice(1).map(file => expandWord(file, scope.env ?? {}))
  if (files.length === 0) return cat.stdinLive ? undefined : cat.stdin
  const bodies = files.map(file =>
    file === undefined || file.startsWith('-') ? undefined : readAt(file, ctx, scope),
  )
  return bodies.includes(undefined) ? undefined : bodies.join('')
}

/** A marked word as the shell will pass it, or undefined when the guard cannot be sure of it. */
function resolveWord(
  marked: string,
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
): string | undefined {
  if (!marked.includes(LIVE)) return marked
  if (scope.env === undefined) return undefined
  const printed: (string | undefined)[] = []
  let text = marked
  for (const sub of cmd.substitutions.filter(s => marked.includes(LIVE + s.raw))) {
    text = text.replace(LIVE + sub.raw, () => HOLE)
    printed.push(printedBy(sub, ctx, scope))
  }
  const parts = expandWord(text, scope.env)?.split(HOLE)
  if (parts?.length !== printed.length + 1 || printed.includes(undefined)) return undefined
  return parts.map((part, i) => part + (printed[i] ?? '')).join('')
}

const GH_TEXT_VERBS = new Set(['create', 'new', 'edit', 'comment', 'review', 'merge'])
const GH_REPO_FLAGS = new Set(['-R', '--repo'])

/** The first word after the group that is not a flag, or the first one the shell expands. */
function ghVerb(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a.includes(LIVE) || !a.startsWith('-')) return a
    if (GH_REPO_FLAGS.has(a)) i++
  }
  return ''
}

type GhKind = 'pr' | 'api' | 'other' | 'unknown'

/** Which text a gh command can post, from its marked words; unknown when the group or verb is expanded. */
export function ghKind(marked: readonly string[]): GhKind {
  const group = marked[0] ?? ''
  if (group.includes(LIVE)) return 'unknown'
  if (group === 'api') return 'api'
  if (group !== 'pr' && group !== 'issue') return 'other'
  const verb = ghVerb(marked.slice(1))
  if (verb.includes(LIVE)) return 'unknown'
  return GH_TEXT_VERBS.has(verb) ? 'pr' : 'other'
}

export const longValue = (arg: string, name: string): string | undefined =>
  arg === name ? '' : arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined

/** gh takes `-dF file`, a short flag behind other short flags, as well as `-F file` and `-Ffile`. */
export function shortValue(arg: string, name: string): string | undefined {
  const letter = name[1] as string
  const at = /^-[A-Za-z]+/.exec(arg)?.[0].indexOf(letter) ?? -1
  return at < 0 ? undefined : arg.slice(at + 1).replace(/^=/, '')
}

/** Every value of a flag, in `--flag v`, `--flag=v`, `-f v`, `-fv` and `-xf v` spellings. */
export function flagValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = []
  args.forEach((arg, i) => {
    for (const name of names) {
      const value = name.startsWith('--') ? longValue(arg, name) : shortValue(arg, name)
      if (value !== undefined && value !== '') values.push(value)
      else if (value === '' && i + 1 < args.length) values.push(args[i + 1] as string)
    }
  })
  return values
}

function readBody(file: string, cmd: SimpleCommand, ctx: GuardContext, scope: Scope): string | undefined {
  if (file !== '-') return readAt(file, ctx, scope)
  return cmd.stdinLive ? undefined : cmd.stdin
}

/** The deny for text the guard could not read, naming the backslash when a heredoc holds the cause. */
const unread = (cmds: readonly SimpleCommand[]): string =>
  cmds.some(cmd => cmd.backslash) ? REASONS.heredocBackslash : REASONS.unreadableBody

/** zsh feeds a command its pipe as well as its heredoc, so stdin behind a pipe is never the text the guard read. */
const piped = (cmd: SimpleCommand): boolean => cmd.before === '|'

function collect({ inline, files }: Sources, cmd: SimpleCommand, ctx: GuardContext, scope: Scope): Texts {
  const texts = [...inline]
  for (const { label, file } of files) {
    if (file === '-' && (cmd.stdin === undefined || piped(cmd))) return { reason: REASONS.stdinBody }
    const text = readBody(file, cmd, ctx, scope)
    if (text === undefined) return { reason: file === '-' ? unread([cmd]) : REASONS.unreadableBody }
    texts.push({ label, text })
  }
  return { texts }
}

/** A file as one comparable key: absolute where the directory is known, else relative and marked. */
function pathKey(file: string, scope: Scope): string {
  if (path.isAbsolute(file)) return path.resolve(file)
  return scope.cwd === undefined ? `?/${path.normalize(file)}` : path.resolve(scope.cwd, file)
}

/** The files a command writes by redirect or `tee`; undefined for a target the guard cannot resolve. */
function writtenBy(cmd: SimpleCommand, ctx: GuardContext, scope: Scope): (string | undefined)[] {
  const targets = [...cmd.writes]
  if (path.basename(cmd.words[0] ?? '') === 'tee')
    targets.push(...cmd.marked.slice(1).filter(w => !w.startsWith('-')))
  return targets.map(word => {
    const file = resolveWord(word, cmd, ctx, scope)
    return file === undefined ? undefined : pathKey(file, scope)
  })
}

/** Each argument as a path, and its value after an `=` (`dd of=f`, `--output=f`); unresolved words drop out. */
function namedBy(cmd: SimpleCommand, ctx: GuardContext, scope: Scope): string[] {
  const words = cmd.marked.slice(1).flatMap(word => [word, word.slice(word.indexOf('=') + 1)])
  return words.flatMap(word => {
    const file = resolveWord(word, cmd, ctx, scope)
    return file === undefined || file === '' ? [] : [pathKey(file, scope)]
  })
}

/**
 * Whether the line wrote, or merely named, a body file before gh reads it, or wrote a file the guard
 * cannot name. Any earlier command may write it (`cp`, `sed -i`, `dd of=`, `sh -c`, `python`).
 */
function postsWrittenBody(sources: Sources, scope: Scope, own: readonly (string | undefined)[]): boolean {
  const written = [...scope.written, ...own]
  const keys = new Set(written.filter(key => key !== undefined))
  const unnamed = written.includes(undefined)
  const named = ({ file }: BodyFile): boolean =>
    keys.has(pathKey(file, scope)) || scope.earlier.some(word => word.includes(file))
  return sources.files.some(body => body.file !== '-' && (unnamed || named(body)))
}

export function prSources(args: readonly string[]): Sources {
  const inline = [
    ...flagValues(args, ['--title', '--subject', '-t']).map(text => ({ label: 'title', text })),
    ...flagValues(args, ['--body', '-b']).map(text => ({ label: 'body', text })),
  ]
  const files = flagValues(args, ['--body-file', '-F']).map(file => ({ label: 'body', file }))
  return { inline, files }
}

export function apiSources(args: readonly string[]): Sources {
  const value = (f: string): string => f.slice(f.indexOf('=') + 1)
  const raw = flagValues(args, ['-f', '--raw-field']).map(value)
  const typed = flagValues(args, ['-F', '--field']).map(value)
  const inline = [...raw, ...typed.filter(v => !v.startsWith('@'))].map(text => ({ label: 'field', text }))
  const files = [
    ...typed.filter(v => v.startsWith('@')).map(v => ({ label: 'field', file: v.slice(1) })),
    ...flagValues(args, ['--input']).map(file => ({ label: 'input', file })),
  ]
  return { inline, files }
}

const API_VALUE_FLAGS = new Set(
  '-X --method -f --raw-field -F --field -H --header --input -q --jq -t --template --hostname --cache -p --preview'.split(
    ' ',
  ),
)

/** The endpoint of a `gh api` call: every word that is neither a flag nor a flag's value. */
function apiEndpoints(args: readonly string[]): string[] {
  const endpoints: string[] = []
  for (let i = 1; i < args.length; i++) {
    const a = args[i] as string
    if (API_VALUE_FLAGS.has(a)) i++
    else if (!a.startsWith('-')) endpoints.push(a)
  }
  return endpoints
}

const MERGE_ENDPOINT = /^\/?repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/

/** A merge has no pre-push scan behind it to refuse, so a missing term list must not block every merge. */
export function isMerge(args: readonly string[]): boolean {
  const endpoints = apiEndpoints(args)
  return args[0] === 'api' && endpoints.length === 1 && MERGE_ENDPOINT.test(endpoints[0] as string)
}

/** `label line n rule[ #term]` for each hit; the line's text never appears. */
export function findingsIn(texts: readonly Text[], rules: readonly TermRule[]): string[] {
  return texts.flatMap(({ label, text }) =>
    text
      .split('\n')
      .flatMap((line, i) =>
        matchRules(line, rules).map(
          hit =>
            `${label} line ${i + 1} ${hit.rule}${hit.termIndex === undefined ? '' : ` #${hit.termIndex}`}`,
        ),
      ),
  )
}

/**
 * Whether the run-time scan in `gh-write` covers what the guard cannot read: the command word is
 * the bare, unwrapped `agent-chat` at the top level, the hook's own install is what `PATH` finds,
 * `PATH` is not mentioned on the line, and every command before it is from the allowlist.
 */
function defersToGhWrite(
  cmd: SimpleCommand,
  assigns: readonly string[],
  ctx: GuardContext,
  scope: Scope,
): boolean {
  return (
    ctx.scansGhWrite === true &&
    scope.deferrable &&
    !cmd.nested &&
    cmd.marked[0] === 'agent-chat' &&
    assigns.length === 0 &&
    scope.env?.PATH !== undefined
  )
}

const PLAIN_COMMANDS = new Set(['cat', 'printf', 'echo', 'tee'])

/**
 * Whether a command before `agent-chat` is one of `cat`, `printf`, `echo` and `tee`, with no
 * variable on it and words the guard can resolve. Anything else, `cd`, `git`, an assignment, a
 * function definition, `export`, `eval` and `source` included, is not.
 */
function plainCommand(cmd: SimpleCommand, ctx: GuardContext, scope: Scope): boolean {
  const [head, ...args] = cmd.marked
  if (head === undefined || !PLAIN_COMMANDS.has(head)) return false
  if (!cmd.marked.every(word => resolveWord(word, cmd, ctx, scope) !== undefined)) return false
  return !(head === 'printf' && args.some(arg => arg.startsWith('-v')))
}

// zsh reads its startup file on every `-c`, and ksh may, so neither is plain.
const PLAIN_SHELLS = new Set(['sh', 'bash', 'dash'])

/** A shell with no startup flag or environment on the line, running one `-c` script. */
const plainShell = (cmd: SimpleCommand, assigns: readonly string[]): boolean =>
  PLAIN_SHELLS.has(cmd.marked[0] ?? '') &&
  assigns.length === 0 &&
  cmd.marked[1] === '-c' &&
  cmd.marked.length === 3

/** The marked words a command writes to by redirect or `tee`. */
function writeWords(cmd: SimpleCommand): string[] {
  const tee = path.basename(cmd.words[0] ?? '') === 'tee'
  return [...cmd.writes, ...(tee ? cmd.marked.slice(1).filter(w => !w.startsWith('-')) : [])]
}

const literalTargets = (cmd: SimpleCommand, scope: Scope): (string | undefined)[] =>
  writeWords(cmd).map(word => (word.includes(LIVE) ? undefined : pathKey(unmark(word), scope)))

// `&>` and `>&file` write a file the splitter does not record; `>&2` and `>&-` only duplicate a descriptor.
const UNRECORDED_WRITE = /&>|>&(?![\d-])/

const NULL_DEVICE = '/dev/null'
const BODY_NAME = /\.(?:md|txt)$/i

const isSymlink = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

const sameFile = (a: string, b: string): boolean => {
  try {
    const [x, y] = [fs.statSync(a), fs.statSync(b)]
    return x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

/**
 * A file the line may write and `gh-write` may read: a `.md` or `.txt` path with no symlink in any
 * component and no `.git` directory above it, that is neither the install nor a file in its
 * `PATH` directory, nor a hard link to it.
 */
function safeBodyPath(key: string, ctx: GuardContext): boolean {
  if (!path.isAbsolute(key) || !BODY_NAME.test(key)) return false
  const parts = key.split(path.sep).filter(part => part !== '')
  if (parts.includes('.git')) return false
  const prefixes = parts.map((_, i) => path.sep + parts.slice(0, i + 1).join(path.sep))
  if (prefixes.some(isSymlink)) return false
  const { install } = ctx
  if (install === undefined) return true
  return path.dirname(key) !== install.dir && key !== install.file && !sameFile(key, install.file)
}

/**
 * Deferral covers only a line with at most one body source, whose earlier commands write at most
 * one safe body file (and `/dev/null`), and whose own redirects write nothing else.
 */
function writesOnlySafeBody(sources: Sources, cmd: SimpleCommand, ctx: GuardContext, scope: Scope): boolean {
  if (UNRECORDED_WRITE.test(scope.line) || sources.files.length > 1) return false
  if (literalTargets(cmd, scope).some(key => key !== NULL_DEVICE)) return false
  const written = new Set(scope.targets.filter(key => key !== NULL_DEVICE))
  return written.size <= 1 && [...written].every(key => key !== undefined && safeBodyPath(key, ctx))
}

/** What `collect` reads, leaving out each file or stdin the guard cannot attribute: `gh-write` scans those at run time. */
function collectReadable(
  { inline, files }: Sources,
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
): Text[] {
  const texts = [...inline]
  for (const { label, file } of files) {
    if (file === '-' && (cmd.stdin === undefined || piped(cmd))) continue
    const text = readBody(file, cmd, ctx, scope)
    if (text !== undefined) texts.push({ label, text })
  }
  return texts
}

const termsRefusal = (terms: TermsLoad, merge: boolean): string | undefined => {
  if (terms.kind === 'unreadable') return REASONS.unreadableTerms
  return terms.kind === 'missing' && MISSING_TERMS_REFUSES && !merge ? REASONS.missingTerms : undefined
}

const publishes = (found: readonly string[]): string =>
  `leak-guard: this text would publish private data (${found.join('; ')}). Remove the flagged text and retry; the guard never prints what matched. ${DOCS}`

const UNRESOLVED = '\0unresolved'

/** Scans what the guard can read and leaves the rest to the run-time scan in `gh-write`. */
function checkDeferred(
  kind: GhKind,
  args: readonly (string | undefined)[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
): string | undefined {
  const known = kind !== 'unknown' && args.every(arg => arg !== undefined)
  // An unresolved word keeps its place, so each flag still pairs with its own value.
  const resolved = kind === 'unknown' ? [] : args.map(arg => arg ?? UNRESOLVED)
  const sources = kind === 'api' ? apiSources(resolved) : prSources(resolved)
  if (known && sources.inline.length + sources.files.length === 0) return undefined
  const refusal = termsRefusal(ctx.terms, known && isMerge(resolved))
  if (refusal !== undefined) return refusal
  const rules = ctx.terms.kind === 'ok' ? ctx.terms.rules : []
  const found = findingsIn(collectReadable(sources, cmd, ctx, scope), rules)
  return found.length === 0 ? undefined : publishes(found)
}

function deferredWritesOnlyBody(
  kind: GhKind,
  args: readonly (string | undefined)[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
): boolean {
  const resolved = kind === 'unknown' ? [] : args.map(arg => arg ?? UNRESOLVED)
  return writesOnlySafeBody(kind === 'api' ? apiSources(resolved) : prSources(resolved), cmd, ctx, scope)
}

const LINE_JOINS = new Set(['', ';', '\n'])

/** A command that only sets variables, each to a value no expansion can change. */
const literalAssignments = (cmd: SimpleCommand): boolean =>
  cmd.marked.length > 0 && cmd.marked.every(word => ASSIGNMENT.test(word) && !word.includes(LIVE))

/** A `gh api` call, behind literal assignments only, with no redirect, pipe or heredoc. */
function plainApiCall(cmd: SimpleCommand): boolean {
  const at = cmd.marked.findIndex(word => !ASSIGNMENT.test(word))
  const prefix = cmd.marked.slice(0, Math.max(at, 0))
  return (
    cmd.marked[at] === 'gh' &&
    cmd.marked[at + 1] === 'api' &&
    !prefix.some(word => word.includes(LIVE)) &&
    cmd.writes.length === 0 &&
    cmd.stdin === undefined &&
    !cmd.stdinLive
  )
}

const PROXY_VAR = /^(?:https?|all)_proxy$/i
const DEFAULT_HOST = 'github.com'

/** A literal setting that sends gh to another host or through a proxy; expansions are denied by the line rule. */
function reroutes(cmd: SimpleCommand): boolean {
  const words = cmd.marked.map(unmark)
  const assigned = words.some(word => {
    const name = ASSIGNMENT.exec(word)?.[1] ?? ''
    const value = assignedValue(word)
    const unknownHost = SUBSCRIPTED_OR_APPENDING.test(word)
    return PROXY_VAR.test(name) || (name === 'GH_HOST' && (unknownHost || value !== DEFAULT_HOST))
  })
  const hosts = words.flatMap((word, i) =>
    word === '--hostname' ? [words[i + 1]] : word.startsWith('--hostname=') ? [word.slice(11)] : [],
  )
  return assigned || hosts.some(host => host !== DEFAULT_HOST)
}

const GH_HOME_VARS = new Set(['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME'])

/** An assignment that may point gh at another config, so its http_unix_socket; only a literal copy of the hook's own value is safe. */
function setsGhHome(marked: readonly string[], env: Env): boolean {
  return marked.some(word => {
    const name = ASSIGNMENT.exec(word)?.[1]
    if (name === undefined || !GH_HOME_VARS.has(name)) return false
    if (word.includes(LIVE) || SUBSCRIPTED_OR_APPENDING.test(word)) return true
    return assignedValue(word) !== env[name]
  })
}

/**
 * A read the guard allows unread must not go where the shell's environment, which the guard cannot
 * read, sends it. So the line may hold only `gh api` calls and literal assignments: anything else,
 * such as `declare`, `read`, `export`, `env` or a compound, could set GH_HOST, a proxy or a home.
 */
function unreadableRoute(ctx: GuardContext, scope: Scope): string | undefined {
  const cmds = parseShell(scope.line)
  const plain = cmds.every(
    cmd =>
      !cmd.nested &&
      LINE_JOINS.has(cmd.before) &&
      LINE_JOINS.has(cmd.after) &&
      (literalAssignments(cmd) || plainApiCall(cmd)),
  )
  if (!plain) return REASONS.ghApiRoute
  if (cmds.some(cmd => setsGhHome(cmd.marked, ctx.env))) return REASONS.ghConfigHome
  return cmds.some(reroutes) ? REASONS.ghApiHost : undefined
}

/** The deny for a gh call with a word the guard cannot resolve; a quoted read-only `gh api` is the one exception. */
function unsureGh(
  kind: GhKind,
  marked: readonly string[],
  args: readonly (string | undefined)[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
): string | undefined {
  const read = kind === 'api' ? classifyApiRead(marked, args, cmd.splits) : 'other'
  if (read === 'read') return unreadableRoute(ctx, scope)
  if (read === 'splits') return REASONS.ghApiUnquoted
  return unread(cmd.substitutions.flatMap(sub => sub.commands))
}

function checkGh(
  marked: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  defers = false,
): string | undefined {
  const kind = ghKind(marked)
  if (kind === 'other') return undefined
  if (setsGhHome(assigns, ctx.env)) return REASONS.ghConfigHome
  const args = marked.map(word => resolveWord(word, cmd, ctx, scope))
  if (defers && deferredWritesOnlyBody(kind, args, cmd, ctx, scope))
    return checkDeferred(kind, args, cmd, ctx, scope)
  const unsure = kind === 'unknown' || !args.every(arg => arg !== undefined)
  if (unsure) return unsureGh(kind, marked, args, cmd, ctx, scope)
  const sources = kind === 'api' ? apiSources(args) : prSources(args)
  if (sources.inline.length + sources.files.length === 0) return undefined
  if (postsWrittenBody(sources, scope, writtenBy(cmd, ctx, scope))) return REASONS.writtenBody
  const collected = collect(sources, cmd, ctx, scope)
  if ('reason' in collected) return collected.reason
  const refusal = termsRefusal(ctx.terms, isMerge(args))
  if (refusal !== undefined) return refusal
  const found = findingsIn(collected.texts, ctx.terms.kind === 'ok' ? ctx.terms.rules : [])
  return found.length === 0 ? undefined : publishes(found)
}

/**
 * `gh alias set` stores a body that runs later, wherever and with whatever arguments, so the
 * directory and `$1` stay unresolved. A plain body runs as another gh command.
 */
function checkGhAliasSet(
  set: GhAliasSet,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  if (set.kind === 'hidden') return REASONS.ghAliasHidden
  if (set.kind === 'unread') return REASONS.ghAliasUnread
  if (set.kind === 'spaced') return REASONS.ghAliasUnreadable
  const { shell, body } = set.alias
  const reason = checkAt(
    shell ? body : `gh ${body}`,
    ctx,
    { ...scope, cwd: undefined, env: undefined },
    depth + 1,
  )
  // The arguments arrive later, and a positional inside double quotes is one the guard cannot fill.
  return reason ?? (shell && unfillableAtSet(body) ? REASONS.ghAliasHidden : undefined)
}

/** gh config writes the guard does not read before an alias in the same line runs. */
const WRITES_GH_CONFIG = [
  /\bgh\s+(?:alias\s+(?:set|import|delete)|config\s+set)\b/,
  /\b(?:config|hosts)\.ya?ml\b/,
  // The config directory itself (`mv`, `cp -r`, `ln -sfn`, `tar -C`), as `.config/gh` or, once
  // `$XDG_CONFIG_HOME` is read out of the line, a bare `/gh`.
  /\.config\/gh(?![\w.-])/,
  /(?:^|[\s'"=:])\/gh(?![\w.-])/m,
]

/** The line names gh's config file or directory, the hook's own `GH_CONFIG_DIR`, or reads `$GH_CONFIG_DIR`. */
function writesGhConfig(ctx: GuardContext, scope: Scope): boolean {
  const dir = ghConfigDir(ctx.env)
  return (
    WRITES_GH_CONFIG.some(pattern => pattern.test(scope.said)) ||
    /\$\{?GH_CONFIG_DIR\b/.test(scope.line) ||
    (dir !== undefined && scope.line.includes(dir))
  )
}

/**
 * Whether gh may read its aliases from a config other than the one the hook reads, judged from the
 * scope's environment as `aliasEnv` judges git's: an environment the guard lost track of (after
 * `. file`, `source` or `eval`), an earlier export or unset that differs from the hook's value, a
 * setting it cannot tell, or a use of the name it does not model all count.
 */
function changesGhHome(assigns: readonly string[], ctx: GuardContext, scope: Scope): boolean {
  if (scope.env === undefined || setsGhHome(assigns, ctx.env)) return true
  return [...GH_HOME_VARS].some(name =>
    scope.exports.has(name) ? scope.exports.get(name) !== ctx.env[name] : mentions(scope.said, name),
  )
}

/**
 * gh's alias machinery (TP-2371): a body is checked when `gh alias set` stores it and again when
 * `gh <alias>` runs it. The command words are found past gh's flags the way cobra finds them.
 */
function checkGhAliases(
  marked: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  const args = marked.map(word => resolveWord(word, cmd, ctx, scope))
  const at = ghCommandWords(args, 3)
  const [verb, sub] = at.map(i => args[i])
  if (verb !== 'alias' || !(sub === 'set' || sub === 'import' || at[1] === HIDDEN))
    return checkGhAliasRun(args, at, assigns, ctx, scope, depth)
  if (at[1] === HIDDEN) return REASONS.ghAliasHidden
  if (sub === 'import') return REASONS.ghAliasUnread
  const set = ghAliasSet(args.filter((_, i) => i !== at[0] && i !== at[1]))
  return set === undefined ? undefined : checkGhAliasSet(set, ctx, scope, depth)
}

/** Without a config to read, a word that is not a gh command runs an extension. */
function runsExtension(args: readonly (string | undefined)[], at: readonly number[]): boolean {
  if (at.length === 0 || at[0] === HIDDEN) return false
  const slot = ghAliasSlot(at.map(i => args[i]))
  return slot !== undefined && ghExtensionSlot(slot)
}

/** The config aliases gh may run for these command words, and which words name the alias; none for a word that may name one in another config. */
type AliasAt = { aliases: readonly GhAlias[]; words: readonly number[]; extension: boolean }

/**
 * Which aliases gh would run, compared on gh's canonical command path (`gh cs x` runs key
 * `codespace x`, and `gh repo deploy-key x` runs key `repo deploy-key x`). A deny when the guard
 * cannot tell, undefined when the words cannot run an alias.
 */
function ghAliasAt(
  args: readonly (string | undefined)[],
  at: readonly number[],
  read: ReadGhAliases,
): AliasAt | string | undefined {
  if (at[0] === HIDDEN) return REASONS.ghAliasHidden
  if (at.length === 0) return undefined
  // A spaced alias name takes over real commands too, so every gh command reads the config.
  const config = read()
  if (config.kind === 'unreadable') return REASONS.ghAliasUnreadable
  const slot = ghAliasSlot(at.map(i => args[i]))
  if (slot === undefined) return undefined
  const words = at.slice(0, slot.used)
  const extension = ghExtensionSlot(slot)
  if (slot.word !== undefined)
    return { aliases: ghAliasesAt(config.aliases, slot.parent, slot.word), words, extension }
  return ghAliasesUnder(config.aliases, slot.parent)
    ? REASONS.ghAliasHidden
    : { aliases: [], words, extension }
}

/** A shell alias runs its body with the words filled in; a plain one runs as another gh command. */
function checkGhAliasBody(
  alias: GhAlias,
  rest: readonly string[],
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  if (alias.shell && fillsUnsafely(alias.body, rest)) return REASONS.ghAliasHidden
  if (alias.shell) return checkAt(ghShellAlias(alias.body, rest), ctx, scope, depth + 1)
  const expanded = ghPlainAlias(alias.body, rest)
  return expanded === undefined
    ? undefined
    : checkAt(['gh', ...expanded].map(quoted).join(' '), ctx, scope, depth + 1)
}

function checkGhAliasRun(
  args: readonly (string | undefined)[],
  at: readonly number[],
  assigns: readonly string[],
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  if (ctx.readGhAliases === undefined) return runsExtension(args, at) ? REASONS.ghExtension : undefined
  const found = ghAliasAt(args, at, ctx.readGhAliases)
  if (found === undefined || typeof found === 'string') return found
  if (writesGhConfig(ctx, scope)) return REASONS.ghAliasWritten
  if (changesGhHome(assigns, ctx, scope)) return REASONS.ghAliasEnv
  const { aliases, words } = found
  if (aliases.length === 0) return found.extension ? REASONS.ghExtension : undefined
  if (scope.aliases >= MAX_ALIASES) return REASONS.aliasDepth
  const rest = args.filter((_, i) => !words.includes(i))
  if (!rest.every(arg => arg !== undefined)) return REASONS.ghAliasHidden
  const inner = { ...scope, aliases: scope.aliases + 1 }
  for (const alias of aliases) {
    const reason = checkGhAliasBody(alias, rest, ctx, inner, depth)
    if (reason !== undefined) return reason
  }
  return undefined
}

/**
 * The git and the programs gh runs for its own commands (TP-2371): `gh extension exec`,
 * `gh help <extension>`, and the `git clone` that `gh repo clone|fork` and `gh gist clone` run with
 * the words after the repository or gist, then its aliases.
 */
function checkGhRuns(
  marked: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  const args = marked.map(word => resolveWord(word, cmd, ctx, scope))
  const at = ghCommandWords(args, 2)
  const [verb, sub] = at.map(i => ghCommand(args[i]))
  const unsure = at[1] === HIDDEN
  if (verb === 'extension' && (sub === 'exec' || unsure)) return REASONS.ghExtension
  if (verb === 'help' && at.length > 1 && ghHelpRunsExtension(sub)) return REASONS.ghExtension
  const clones = verb === undefined ? undefined : GH_CLONES.get(verb)
  if (clones !== undefined && (unsure || (sub !== undefined && clones.has(sub)))) {
    // A subcommand the guard cannot resolve may be clone, so every word after the group is clone's.
    const from = (unsure ? at[0] : at[1]) ?? 0
    const reason = checkGhClone(marked.slice(from + 1), assigns, cmd, ctx, scope, depth)
    if (reason !== undefined) return reason
  }
  return checkGhAliases(marked, assigns, cmd, ctx, scope, depth)
}

/** Any URL: the clone checks read the flags git gets, and gh builds the URL from the repository. */
const CLONE_URL = 'https://github.com/o/r.git'

/**
 * The `git clone` gh runs, built as gh's `parseCloneArgs` does: a leading positional is the directory,
 * put after the URL. An unread one goes there too: git reads a flag anywhere, and before the URL it
 * would read as the repository (TP-2444).
 */
function checkGhClone(
  marked: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  const resolved = marked.map(word => resolveWord(word, cmd, ctx, scope))
  const { git, hidden } = ghCloneArgs(resolved)
  if (hidden) return REASONS.ghCloneHidden
  if (git.length === 0) return undefined
  const [first = 0] = git
  const lead = resolved[first]
  const dir = lead === undefined || !lead.startsWith('-') ? [first] : []
  const flags = git.filter(i => !dir.includes(i)).map(i => marked[i] as string)
  const words = ['clone', ...flags, CLONE_URL, ...dir.map(i => marked[i] as string)]
  return checkGitRun(gitRun(words, assigns, cmd, ctx, scope, true), ctx, scope, depth)
}

function checkShell(
  args: readonly string[],
  stdin: string | undefined,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  const flag = args.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a))
  if (flag >= 0) return checkAt(args[flag + 1] ?? '', ctx, scope, depth + 1)
  const script = args.find(a => !a.startsWith('-'))
  return script === undefined && stdin !== undefined ? checkAt(stdin, ctx, scope, depth + 1) : undefined
}

/** The gh args `gh-write <gh-args...>` hands gh: commander drops only the first `--` and keeps the words on both sides. */
function ghWriteArgs(args: readonly string[]): readonly string[] {
  const rest = args.slice(1)
  const end = rest.indexOf('--')
  return end < 0 ? rest : [...rest.slice(0, end), ...rest.slice(end + 1)]
}

const postsText = (marked: readonly string[]): boolean => ['pr', 'api'].includes(ghKind(marked))

/**
 * A command word the guard cannot resolve may be git or gh, so its arguments are checked as both.
 * It may also expand to nothing, a wrapper, or a wrapper and its options, so every suffix of the
 * words after it is checked as a command (CC-347). A hidden word inside those suffixes checks only
 * its own arguments, since the outermost one already visits every later word.
 */
function checkHidden(
  [head = '', ...marked]: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
  outermost: boolean,
): string | undefined {
  const viaWrite = unmark(marked[0] ?? '') === 'gh-write' && postsText(ghWriteArgs(marked))
  if (postsText(marked) || viaWrite) return REASONS.hiddenCommand
  const unseen = { ...scope, cwd: undefined, env: undefined }
  const starts = outermost ? marked.flatMap((word, i) => (mayStartCommand(word) ? [i] : [])) : []
  scope.hiddenStarts.left -= starts.length
  const spent = scope.hiddenStarts.left < 0
  if (spent && lineMayReachGit(scope, ctx)) return REASONS.hiddenStarts
  const reason =
    firstReason(spent ? [] : starts, i =>
      checkSimple(suffixCommand(cmd, marked.slice(i)), ctx, unseen, depth, false),
    ) ??
    checkGitRun(
      gitRun(marked, assigns, cmd, ctx, scope, false, tiedToGit(head, cmd, ctx, scope)),
      ctx,
      scope,
      depth,
    )
  return reason === REASONS.unreadableBody ? REASONS.hiddenBody : reason
}

const SUBSTITUTION = /\$\(|`|[<>]\(/

/** Whether any word of the line names git or gh, may expand to either, or reads a variable the line or the hook ties to them (CC-478). */
function mayReachGit(line: string, env: Env): boolean {
  if (MENTIONS_GIT.test(line) || SUBSTITUTION.test(line) || ANSI_C.test(line)) return true
  if (UNNAMED_SET.test(line) || HIDDEN_NAME.test(line)) return true
  const said = unreferenced(line).replace(READ_ONLY_REF, ' ')
  const names = [...line.matchAll(VARIABLE)].map(match => match[1] as string)
  if (names.some(name => mentions(said, name) || wordMayBeGit(env[name] ?? ''))) return true
  return line.split(/[\s;&<>]+/).some(word => wordMayBeGit(word) || wordMayBeGit(withEnv(word, env)))
}

const ANSI_C = /\$'/

// Past the budget a hidden git's arguments go unchecked, so a word that may push or skip hooks counts as reaching it.
const RISKY_WORD = /\b(?:git|gh)\b|GIT_CONFIG|push|no-?veri|hookspath|include|alias/i
const RISKY_NAMES = ['git', 'gh', 'push', '--no-verify', '--no-veri']

const wordMayBeGit = (word: string): boolean =>
  RISKY_WORD.test(word.replace(QUOTING, '')) || RISKY_NAMES.some(name => mayExpandTo(word, name))

/** The word with each `$NAME` and `${NAME}` replaced by the hook env's value, so joined variables are tested as one. */
const withEnv = (word: string, env: Env): string =>
  word.replace(REFERENCE, ref => env[ref.replace(/[${}]/g, '')] ?? '')

function lineMayReachGit(scope: Scope, ctx: GuardContext): boolean {
  scope.hiddenStarts.reachesGit ??= mayReachGit(scope.line, ctx.env)
  return scope.hiddenStarts.reachesGit
}

const mayStartCommand = (word: string): boolean =>
  word.includes(LIVE) ||
  PREFIX_WORDS.has(word) ||
  ASSIGNMENT.test(word) ||
  CHECKED_NAMES.has(path.basename(word))

const suffixCommand = (cmd: SimpleCommand, marked: readonly string[]): SimpleCommand => ({
  ...cmd,
  words: marked.map(unmark),
  marked: [...marked],
})

function firstReason<T>(items: readonly T[], check: (item: T) => string | undefined): string | undefined {
  for (const item of items) {
    const reason = check(item)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** Checks the text `eval` runs; text the guard cannot resolve is a deny on a line that names git or gh. */
function checkEval(
  marked: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  const args = marked.map(word => resolveWord(word, cmd, ctx, scope))
  if (args.includes(undefined) && scope.namesGit) return REASONS.hiddenScript
  return checkAt(args.map((arg, i) => arg ?? unmark(marked[i] as string)).join(' '), ctx, scope, depth + 1)
}

/** Whether unwrapping only dropped leading words, rather than splitting new ones out as `env -S` does. */
const isTail = (tail: readonly string[], words: readonly string[]): boolean =>
  tail.every((word, i) => word === words[words.length - tail.length + i])

/** `function f { gh ...; }` runs nothing yet, but its body is checked as if it ran now. */
const functionBody = (marked: readonly string[]): readonly string[] =>
  marked[0] === 'function' ? marked.slice(2) : marked

function checkSimple(
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
  outermost = true,
  lead?: Lead,
): string | undefined {
  const unwrapped = unwrap(functionBody(cmd.marked), cmd.splits, lead)
  if ('reason' in unwrapped) return unwrapped.reason
  const sibling = firstReason(unwrapped.siblings ?? [], s =>
    checkSimple(suffixCommand(cmd, s.words), ctx, scope, depth, outermost, s),
  )
  if (sibling !== undefined) return sibling
  const at = unwrapped.chdir ? { ...scope, cwd: undefined } : scope
  const words = stdinArgs(unwrapped.words, unwrapped.fed)
  const marked = words.slice(1)
  const head = resolveWord(words[0] ?? '', cmd, ctx, at)
  if (head === undefined) {
    // An `env -S` split behind another expansion would rescan every suffix at each level.
    if (!outermost && !isTail(unwrapped.words, cmd.marked)) return REASONS.hiddenCommand
    return checkHidden(words, unwrapped.assigns, cmd, ctx, at, depth, outermost)
  }
  const args = marked.map(unmark)
  const name = path.basename(head)
  if (SHELLS.has(name)) {
    const inner = plainShell(cmd, unwrapped.assigns) ? at : { ...at, deferrable: false }
    return checkShell(args, cmd.stdin, ctx, inner, depth)
  }
  if (name === 'eval') return checkEval(marked, cmd, ctx, { ...at, deferrable: false }, depth)
  if (name === 'git')
    return checkGitRun(gitRun(marked, unwrapped.assigns, cmd, ctx, at, true), ctx, at, depth)
  if (name === 'gh')
    return head === 'gh'
      ? (checkGhRuns(marked, unwrapped.assigns, cmd, ctx, at, depth) ??
          checkGh(marked, unwrapped.assigns, cmd, ctx, at))
      : REASONS.ghByPath
  if (name === 'agent-chat' && args[0] === 'gh-write') {
    const defers = head === 'agent-chat' && defersToGhWrite(cmd, unwrapped.assigns, ctx, at)
    const ghArgs = ghWriteArgs(marked)
    return (
      checkGhRuns(ghArgs, unwrapped.assigns, cmd, ctx, at, depth) ??
      checkGh(ghArgs, unwrapped.assigns, cmd, ctx, at, defers)
    )
  }
  if (SSH_PROGRAMS.has(name))
    return sshRunsLocalProgram(name, marked, cmd.splits) ? REASONS.sshProgram : undefined
  if (ENV_EDITS.has(name)) return checkEnvEdit(args)
  return undefined
}

const CD_WORDS = new Set(['cd', 'chdir', 'pushd', 'popd'])
const OPAQUE = new Set('eval source . function alias setopt unsetopt shopt emulate trap'.split(' '))
const PLAIN_SET = /^(?:[-+][euxo]+|pipefail|errexit|nounset|xtrace)$/

/** A command that can change the directory or any variable in a way the command line does not show. */
function isOpaque(cmd: SimpleCommand, ctx: GuardContext, scope: Scope): boolean {
  const unwrapped = unwrap(cmd.marked)
  const words = 'reason' in unwrapped ? [] : unwrapped.words
  const head = resolveWord(words[0] ?? '', cmd, ctx, scope)
  if (head === 'set') return !words.slice(1).every(arg => PLAIN_SET.test(arg))
  return head === undefined || OPAQUE.has(head)
}

/** bash falls back to the old directory when a `..` follows a name that does not exist. */
const climbsBack = (dir: string): boolean =>
  dir
    .split('/')
    .some((seg, i, segs) => seg === '..' && segs.slice(0, i).some(s => !['', '.', '..'].includes(s)))

const JOINS_BEFORE = new Set(['', ';', '\n', '&&'])
const JOINS_AFTER = new Set(['', ';', '\n', '&&', '||'])

/** Where a plain top-level `cd <dir>` leaves the shell; undefined for any other command that may move it. */
function plainCd(cmd: SimpleCommand, ctx: GuardContext, scope: Scope): string | undefined {
  const [head, target, ...rest] = cmd.marked
  const joined = !cmd.nested && JOINS_BEFORE.has(cmd.before) && JOINS_AFTER.has(cmd.after)
  if (head !== 'cd' || target === undefined || rest.length > 0 || !joined) return undefined
  const dir = resolveWord(target, cmd, ctx, scope)
  if (dir === undefined || /^[-+]/.test(dir) || climbsBack(dir)) return undefined
  if (path.isAbsolute(dir)) return path.resolve(dir)
  const searched = scope.cdpath && !/^\.\.?(?:\/|$)/.test(dir)
  return scope.cwd === undefined || searched ? undefined : path.resolve(scope.cwd, dir)
}

/** The scope the next command runs in; a `cd` behind `&&` is unsure once its list ends. */
const SURE_BEFORE = new Set(['', ';', '\n'])

/** The variables a bare `NAME=value`, `export` or `unset` leaves set; a conditional one is UNSURE. */
function exported(cmd: SimpleCommand, ctx: GuardContext, scope: Scope): ReadonlyMap<string, Setting> {
  const unwrapped = unwrap(cmd.marked)
  if ('reason' in unwrapped) return scope.exports
  const [head, ...rest] = unwrapped.words
  const sure = !cmd.nested && SURE_BEFORE.has(cmd.before) && JOINS_AFTER.has(cmd.after)
  const set = new Map(scope.exports)
  const value = (word: string): Setting =>
    sure && !SUBSCRIPTED_OR_APPENDING.test(word)
      ? (resolveWord(assignedValue(word), cmd, ctx, scope) ?? UNSURE)
      : UNSURE
  if (head === undefined)
    for (const word of unwrapped.assigns) set.set(ASSIGNMENT.exec(word)?.[1] ?? '', value(word))
  else if (head === 'export')
    for (const word of rest.filter(w => ASSIGNMENT.test(w)))
      set.set(ASSIGNMENT.exec(word)?.[1] ?? '', value(word))
  else if (head === 'unset')
    for (const word of rest.filter(w => !w.startsWith('-'))) set.set(word, sure ? undefined : UNSURE)
  const builtName = rest.some(w => w.includes(LIVE) && !ASSIGNMENT.test(w))
  if (head !== undefined && ENV_EDITS.has(head) && builtName)
    for (const name of CONFIG_ENV) set.set(name, UNSURE)
  return set
}

function advance(cmd: SimpleCommand, ctx: GuardContext, scope: Scope): Scope {
  const deferrable = scope.deferrable && plainCommand(cmd, ctx, scope)
  const written = [...scope.written, ...writtenBy(cmd, ctx, scope), ...namedBy(cmd, ctx, scope)]
  scope = {
    ...scope,
    deferrable,
    targets: [...scope.targets, ...literalTargets(cmd, scope)],
    written,
    earlier: [...scope.earlier, ...cmd.words.slice(1), ...(cmd.stdin === undefined ? [] : [cmd.stdin])],
  }
  if (isOpaque(cmd, ctx, scope)) return { ...scope, cwd: undefined, env: undefined }
  scope = { ...scope, exports: exported(cmd, ctx, scope) }
  if (!cmd.words.some(word => CD_WORDS.has(word))) return scope
  const cwd = plainCd(cmd, ctx, scope)
  return { ...scope, cwd, fragile: cwd !== undefined && cmd.before === '&&' }
}

const settle = (cmd: SimpleCommand, scope: Scope): Scope =>
  scope.fragile && cmd.before !== '&&' ? { ...scope, cwd: undefined, fragile: false } : scope

// The shell sets these itself, so the hook's copy says nothing about the value a command sees.
const NEVER_EXPANDED = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'IFS'])
const REFERENCE = new RegExp(`\\$\\{${NAME}\\}|\\$${NAME}`, 'g')
// `TMP""DIR=x` and `TMP\DIR=x` assign TMPDIR, so quoting is dropped before a name is looked for.
const QUOTING = /\\\n|['"\\]/g

const unreferenced = (command: string): string => command.replace(REFERENCE, ' ').replace(QUOTING, '')

/** The env without any name the command mentions outside `$NAME` and `${NAME}`: it may assign that name. */
function knownEnv(command: string, env: Env): Env {
  const rest = unreferenced(command)
  const known = ([name]: [string, unknown]): boolean => !NEVER_EXPANDED.has(name) && !rest.includes(name)
  return Object.fromEntries(Object.entries(env).filter(known))
}

// Regex sources for whole names; SHELL_CODE_ENV holds patterns such as BASH_FUNC_*.
const TRUST_NAMES: readonly (readonly [string, TrustEnv])[] = [
  ...TRUST_ENV,
  ...SHELL_CODE_ENV.map(name => [name, 'shellStartup'] as const),
]
const ENV_NAMES = [
  ...PROGRAM_ENV,
  ...OPAQUE_PROGRAM_ENV,
  ...PROTOCOL_ENV,
  ...TRUST_NAMES.map(([name]) => name),
]
const ENV_NAME = new RegExp(`^(?:${ENV_NAMES.join('|')})$`)
// A use of the name that is not a `$NAME` or `${NAME...}` read, or the name glued to an option as in `printf -vNAME`.
const nameUse = (name: string): RegExp =>
  new RegExp(`(?:^-[A-Za-z]*|(?<![A-Za-z0-9_$])(?<!\\$\\{)(?<!\\$\\{[#!]))${name}(?![A-Za-z0-9_])`)
// `${NAME=x}`, `${NAME:=x}` and zsh's `${NAME::=x}` assign; `${NAME-x}` and the other operators only read.
const nameAssign = (name: string): RegExp => new RegExp(`\\$\\{${name}(?:\\[[^\\]]*\\])?:{0,2}=`)
const ENV_REFS = ENV_NAMES.map(name => ({ use: nameUse(name), assign: nameAssign(name) }))

/** Whether a word uses a program env var other than by reading it. */
const namesProgramEnv = (text: string): boolean =>
  ENV_REFS.some(({ use, assign }) => use.test(text) || assign.test(text))

/** Whether a word holds a `${NAME...}` expansion of a program env var that assigns it. */
const expandsProgramEnv = (text: string): boolean => ENV_REFS.some(({ assign }) => assign.test(text))

// The same assigning expansion where the shell expands it, as marked: not inside single quotes.
const LIVE_ASSIGNS = ENV_NAMES.map(name => new RegExp(LIVE + nameAssign(name).source))
const liveExpandsProgramEnv = (marked: string): boolean => LIVE_ASSIGNS.some(assign => assign.test(marked))

/**
 * A program-env event: a script to check, null for a use the guard cannot read, EXT_ON for
 * unsetting the protocol list, or EXT_LISTED for a literal list naming `ext` (CC-1137 d).
 */
const EXT_ON = Symbol('ext-on')
// Nothing legitimate lists ext, so this denies on any line; an unset off a git line is left to the CC-1095 pin.
const EXT_LISTED = Symbol('ext-listed')
// A variable name the shell builds: a programEnv deny, ranked after the per-command checks so their more specific reason wins.
const NAME_HIDDEN = Symbol('name-hidden')
/** A use of a TRUST_ENV name other than a read or an unset (TP-2376): denied with its own reason. */
interface TrustOn {
  trust: TrustEnv
}
type EnvEvent = string | null | typeof EXT_ON | typeof EXT_LISTED | typeof NAME_HIDDEN | TrustOn

const TRUST_REFS = TRUST_NAMES.map(([name, trust]) => ({
  use: nameUse(name),
  assign: nameAssign(name),
  trust,
}))
const TRUST_REASONS: Readonly<Record<TrustEnv, string>> = {
  shellStartup: REASONS.shellStartupEnv,
  execPath: REASONS.gitExecPath,
  templateDir: REASONS.templateDir,
}

/** The trust input a word sets by any use of its name but a read; `assignOnly` counts only an assigning `${NAME:=x}`. */
function trustOn(text: string, assignOnly = false): TrustOn | undefined {
  const ref = TRUST_REFS.find(({ use, assign }) => assign.test(text) || (!assignOnly && use.test(text)))
  return ref === undefined ? undefined : { trust: ref.trust }
}

/** A program-env name's event in a word: a trust input's own event, else null for a use the guard cannot read. */
const nameEvent = (text: string, assignOnly = false): TrustOn | null => trustOn(text, assignOnly) ?? null

const PROTOCOL_USES = [...PROTOCOL_ENV].map(nameUse)
const namesProtocolEnv = (text: string): boolean => PROTOCOL_USES.some(use => use.test(text))

/**
 * The event of a plain `NAME=value` to a PROGRAM_ENV or PROTOCOL_ENV name: a program's literal
 * value, null when the value is unreadable, and for a protocol list EXT_LISTED when it lists `ext` or
 * no event at all. undefined when the word is no such assignment.
 */
function plainProgramValue(word: string): EnvEvent | 'none' | undefined {
  const name = ASSIGNMENT.exec(word)?.[1]
  if (name === undefined || !word.startsWith(`${name}=`)) return undefined
  const protocol = PROTOCOL_ENV.has(name)
  if (!protocol && !PROGRAM_ENV.has(name)) return undefined
  const value = word.slice(name.length + 1)
  if (value.includes(LIVE)) return null
  if (!protocol) return value
  return listsExt(unmark(value)) ? EXT_LISTED : 'none'
}

type WordRole = 'assign' | 'data' | 'removes' | 'arg'
// env's `-uNAME` and `--unset=NAME`.
const GLUED_UNSET = /^-(?:u.|-unset=)/

// A word that names its variable literally: NAME, then a subscript, `=`, `+=` or nothing.
const LITERAL_NAME = new RegExp(`^[A-Za-z_][A-Za-z0-9_]*(?:${LIVE}?\\[|\\+?=|$)`)

/** Whether a word in an assignment's place holds an expansion and does not name its variable literally. */
const hiddenName = (word: string): boolean => word.includes(LIVE) && !LITERAL_NAME.test(word)

// Builtins whose operands are all variable names or may be read as such (`getopts` optstring and
// args, `read -p` prompt): an expansion in any of them fails closed.
const NAME_OPERAND_BUILTINS = new Set(['read', 'getopts', 'mapfile', 'readarray', 'unset'])
// env options whose value is a variable name or a string env splits and expands itself.
const ENV_NAME_OPTIONS = new Set(['-u', '--unset', '-S', '--split-string'])
const ENV_VALUE_OPTIONS = new Set([...ENV_NAME_OPTIONS, '-C', '--chdir'])

/**
 * Whether env's words from `i` hide a variable name: an option the guard cannot read, a `-u` or `-S`
 * value with an expansion, or, before the command and after any `--`, a word with an expansion
 * before its first `=`, which env may read as `NAME=value`.
 */
function envHidesName(words: readonly string[], i: number): boolean {
  let options = true
  for (; i < words.length; i++) {
    const word = words[i] as string
    const text = unmark(word)
    if (options && text === '--') options = false
    else if (options && text.startsWith('-') && text !== '-') {
      if (word.includes(LIVE)) return true
      if (ENV_NAME_OPTIONS.has(text) && (words[i + 1] ?? '').includes(LIVE)) return true
      if (ENV_VALUE_OPTIONS.has(text)) i++
    } else if (hiddenName(word)) return true
    else if (!ASSIGNMENT.test(word)) return false
  }
  return false
}

/** Whether `printf`'s `-v` name holds an expansion, or an operand the shell builds comes before its format and may be `-v`. */
function printfHidesName(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string
    const text = unmark(word)
    if (text === '-v') return (args[i + 1] ?? '').includes(LIVE)
    if (text.startsWith('-v') || word.includes(LIVE)) return word.includes(LIVE)
    if (text === '--' || !text.startsWith('-')) return false
  }
  return false
}

/** Whether a command, past the builtin at its head, takes a variable name the shell builds. */
// The word a `<(...)` or `>(...)` redirection leaves: the shell passes a `/dev/fd` path, never a variable name.
const isProcessSubstitution = (word: string): boolean => word === LIVE

function operandsHideName(name: string, written: readonly string[]): boolean {
  const args = written.filter(word => !isProcessSubstitution(word))
  if (NAME_OPERAND_BUILTINS.has(name)) return args.some(word => word.includes(LIVE))
  if (ENV_DECL.has(name)) return args.some(hiddenName)
  return name === 'printf' && printfHidesName(args)
}

/**
 * Whether a command assigns, reads into or unsets a variable whose name the shell builds (TP-2371),
 * at any command head along its wrapper chain: env's words before the command (after `--` too),
 * and the name operands of read, printf -v, mapfile, readarray, getopts, unset and the declare
 * family. Such a name may be any program var or GIT_ALLOW_PROTOCOL, so it fails closed.
 */
function hidesVariableName(words: readonly string[]): boolean {
  for (let at = 0; at < words.length;) {
    const head = words[at] as string
    const name = path.basename(unmark(head))
    const next = wrapperEnd(words, at, name)
    if (ASSIGNMENT.test(head)) at++
    else if (PREFIX_WORDS.has(head)) at = dropOptions(words, at + 1)
    else if (next !== undefined) at = next
    else if (name === 'env') return envHidesName(words, at + 1)
    else return operandsHideName(name, words.slice(at + 1))
  }
  return false
}
const ENV_DECL = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])
const ENV_UNSET = new Set(['-u', '--unset'])

/** The roles of `env`'s arguments from `i`: its own assignments, and the names `-u` removes. */
function envRoles(marked: readonly string[], i: number, roles: WordRole[]): void {
  for (; i < marked.length; i++) {
    const word = marked[i] as string
    if (ENV_UNSET.has(word)) {
      roles[i] = 'removes'
      roles[++i] = 'removes'
    } else if (GLUED_UNSET.test(unmark(word))) roles[i] = 'removes'
    else if (ASSIGNMENT.test(word)) roles[i] = 'assign'
    // GNU env reads `NAME=value` words after `--` too.
    else if (word !== '--') return
  }
}

/**
 * Whether the command `unwrap` says runs takes its arguments as data: git, gh and
 * `agent-chat gh-write` never assign a shell variable a word names, unlike `read` or `printf -v`.
 */
function takesData(words: readonly string[]): boolean {
  const head = unmark(words[0] ?? '')
  if (head === 'gh') return true
  if (head === 'agent-chat') return unmark(words[1] ?? '') === 'gh-write'
  return path.basename(head) === 'git'
}

/**
 * How the shell reads each word of one command. Only a prefix assignment, an assignment argument
 * of a literal `env`, and an argument of an export-like builtin written as the command word itself
 * are read as an assignment exactly once; a word under `eval` or any other wrapper may be read again.
 */
function wordRoles(cmd: SimpleCommand): WordRole[] {
  const { marked } = cmd
  const roles: WordRole[] = marked.map(() => 'arg')
  let i = 0
  while (i < marked.length && PREFIX_WORDS.has(marked[i] as string)) i++
  for (; i < marked.length && ASSIGNMENT.test(marked[i] as string); i++) roles[i] = 'assign'
  const head = marked[i]
  if (head === 'env') envRoles(marked, i + 1, roles)
  else if (head === 'unset') roles.fill('removes', i)
  else if (head !== undefined && ENV_DECL.has(head)) roles.fill('assign', i + 1)
  const unwrapped = unwrap(marked)
  const data = 'words' in unwrapped && takesData(unwrapped.words)
  if (data && marked.slice(-unwrapped.words.length).join('\0') === unwrapped.words.join('\0'))
    roles.fill('data', marked.length - unwrapped.words.length)
  return roles
}

/**
 * A program-env event for one word. A plain literal `NAME=value` where the shell reads an
 * assignment once gives its value to check. Any other use of a program env name gives null, since
 * the shell has many ways to assign one (`+=`, a subscript, a brace, read, printf -v, a for loop,
 * `${NAME:=x}`, eval); a read is no event. In the arguments of a command that takes them as data,
 * such as git or gh, only an assigning expansion the shell expands counts.
 */
function envEvent(word: string, role: WordRole): EnvEvent | undefined {
  const text = unmark(word)
  // Unsetting a program var only drops a command; unsetting the protocol list lifts the one agent-chat pins.
  if (role === 'removes') return namesProtocolEnv(text) ? EXT_ON : undefined
  if (role === 'data') return liveExpandsProgramEnv(word) ? nameEvent(text, true) : undefined
  const trust = trustOn(text)
  if (trust !== undefined) return trust
  const plain = role === 'assign' ? plainProgramValue(word) : undefined
  if (plain === 'none') return undefined
  if (plain !== undefined) return plain
  return namesProgramEnv(text) ? null : undefined
}

/** A word's text for the git scan, with a program-env assignment's value blanked so a `git` in it does not count. */
function scanWord(word: string): string {
  const um = unmark(word)
  const name = ASSIGNMENT.exec(word)?.[1]
  return name !== undefined && ENV_NAME.test(name) ? um.slice(0, um.indexOf('=') + 1) : um
}

/** How many words at the end of `words` are the written words they end with, so not split out of one. */
function sharedTail(words: readonly string[], written: readonly string[]): number {
  let n = 0
  while (n < words.length && n < written.length && words.at(-1 - n) === written.at(-1 - n)) n++
  return n
}

/** One command's program-env events, and its text for the git scan. */
interface EnvUse {
  events: EnvEvent[]
  scan: string[]
}

/** Events from the command as written; only a word the shell reads as an assignment once has its value blanked for the scan. */
function writtenEnvUse(cmd: SimpleCommand, roles: readonly WordRole[]): EnvUse {
  return {
    events: cmd.marked
      .map((word, i) => envEvent(word, roles[i] as WordRole))
      .filter((event): event is EnvEvent => event !== undefined),
    scan: cmd.marked.map((word, i) => (roles[i] === 'assign' ? scanWord(word) : unmark(word))),
  }
}

/**
 * Events from the command `unwrap` says runs: its assignments and words, including those
 * `env -S` splits out of one word. A word the written command lacks is never read once by the
 * shell, so any program env name in it denies; its words and assignments join the git scan.
 */
function unwrappedEnvUse(cmd: SimpleCommand, roles: readonly WordRole[]): EnvUse {
  const unwrapped = unwrap(functionBody(cmd.marked))
  if ('reason' in unwrapped) return { events: [], scan: [] }
  const { words, assigns } = unwrapped
  const written = new Set(cmd.marked.filter((_, i) => roles[i] !== 'removes'))
  const data = takesData(words)
  const usesEnv = (word: string): boolean =>
    data ? expandsProgramEnv(unmark(word)) : namesProgramEnv(unmark(word))
  const assigned = assigns.filter(w => ASSIGNMENT.test(w) && !written.has(w) && namesProgramEnv(unmark(w)))
  const used = words.slice(0, words.length - sharedTail(words, cmd.marked)).filter(usesEnv)
  return {
    events: [
      ...assigned.map(word => nameEvent(unmark(word))),
      ...used.map(word => nameEvent(unmark(word), data)),
    ],
    scan: [...unwrapped.assigns.map(scanWord), ...unwrapped.words.map(unmark)],
  }
}

/** Every program-env event on one command, read from the words as written and from the unwrapped command. */
function envUse(cmd: SimpleCommand): EnvUse {
  const roles = wordRoles(cmd)
  const written = writtenEnvUse(cmd, roles)
  const unwrapped = unwrappedEnvUse(cmd, roles)
  const hidden: EnvEvent[] = hidesVariableName(functionBody(cmd.marked)) ? [NAME_HIDDEN] : []
  return {
    events: [...written.events, ...unwrapped.events, ...hidden],
    scan: [...written.scan, ...unwrapped.scan],
  }
}

/**
 * Program env vars git runs (TP-636), closed as one conservative line rule. If a program env name
 * is used anywhere on a line that may reach git, by the same test the hidden-command budget uses
 * (CC-478), so a command word such as `${G}t` counts, a plain literal assignment's value is checked
 * as a nested script and any other use denies. Both the uses and the git test read the unwrapped
 * command too, so a wrapper or an `env -S` split hides neither.
 */
function checkProgramEnvLine(
  command: string,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | typeof NAME_HIDDEN | undefined {
  const uses = parseShell(command).map(envUse)
  const events = uses.flatMap(use => use.events)
  if (events.length === 0) return undefined
  if (events.includes(EXT_LISTED)) return REASONS.extProtocol
  const scan = uses.flatMap(use => use.scan).join(' ')
  if (!mayReachGit(scan, ctx.env)) return undefined
  const inner: Scope = { ...scope, cwd: undefined, env: undefined }
  for (const event of events) {
    if (event === null) return REASONS.programEnv
    if (event === EXT_ON || event === EXT_LISTED) return REASONS.extProtocol
    if (event === NAME_HIDDEN) continue
    if (typeof event === 'object') return TRUST_REASONS[event.trust]
    const reason = checkAt(event, ctx, inner, depth + 1)
    if (reason !== undefined) return reason
  }
  return events.includes(NAME_HIDDEN) ? NAME_HIDDEN : undefined
}

/** An unreadable `${...}` hides what follows it, so it denies any line; an operator one only beside gh (CC-718). */
function deniesExpansion(command: string): boolean {
  const risk = expansionRisk(command)
  return risk === 'unreadable' || (risk === 'operator' && NAMES_GH.test(command))
}

function checkAt(command: string, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return REASONS.tooDeep
  if (ctx.protectedPaths.some(p => command.includes(p))) return REASONS.protectedPath
  const cdpath = scope.cdpath || command.includes('CDPATH')
  const namesGit = scope.namesGit || MENTIONS_GIT.test(command)
  const said = `${scope.said}\n${unreferenced(command)}`
  let at: Scope = { ...scope, cdpath, namesGit, said, env: scope.env && knownEnv(command, scope.env) }
  const envReason = checkProgramEnvLine(command, ctx, at, depth)
  if (typeof envReason === 'string') return envReason
  for (const cmd of parseShell(command)) {
    at = settle(cmd, at)
    const reason = checkSimple(cmd, ctx, at, depth)
    if (reason !== undefined) return reason
    at = advance(cmd, ctx, at)
  }
  if (mixesParenAndGuarded(command)) return REASONS.parenMixed
  if (deniesExpansion(command)) return REASONS.operatorExpansion
  return envReason === NAME_HIDDEN ? REASONS.programEnv : undefined
}

export function checkCommand(command: string, ctx: GuardContext): string | undefined {
  const cdpath = Boolean(ctx.env.CDPATH)
  const scope: Scope = {
    cwd: ctx.cwd,
    env: ctx.env,
    fragile: false,
    cdpath,
    namesGit: false,
    aliases: 0,
    exports: new Map(),
    written: [],
    earlier: [],
    said: '',
    deferrable: true,
    targets: [],
    line: command,
    gitParams: [],
    hiddenStarts: { left: MAX_HIDDEN_STARTS },
  }
  return checkAt(command, ctx, scope, 0)
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The deny reason for one tool call, or undefined to leave it to the normal permission flow. */
export function checkToolCall(toolName: string, toolInput: unknown, ctx: GuardContext): string | undefined {
  const input = (toolInput ?? {}) as Record<string, unknown>
  if (toolName === 'Bash')
    return typeof input.command === 'string' ? checkCommand(input.command, ctx) : undefined
  if (!EDIT_TOOLS.has(toolName)) return undefined
  const file = input.file_path ?? input.notebook_path
  if (typeof file !== 'string') return undefined
  const resolved = path.resolve(ctx.cwd, file)
  return ctx.protectedPaths.some(p => resolved.includes(p)) ? REASONS.protectedPath : undefined
}

export const termsFile = (env: NodeJS.ProcessEnv, home: string): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'titan-egress', 'private-terms')

/** Read from the default path only, never `TITAN_EGRESS_TERMS`, so an inherited value cannot empty the list. */
export function loadTerms(file: string): TermsLoad {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  try {
    return { kind: 'ok', rules: parseTerms(text) }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** Opened without blocking and read only when regular, so a FIFO or a device cannot hang the hook. */
export function readText(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf8') : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

const realOf = (file: string): string | undefined => {
  try {
    return fs.realpathSync(file)
  } catch {
    return undefined
  }
}

/** The real install and its `PATH` directory when the first `agent-chat` on PATH is the file this hook runs from. */
export function ownInstall(
  env: NodeJS.ProcessEnv,
  entry: string | undefined,
): { file: string; dir: string } | undefined {
  const own = entry === undefined ? undefined : realOf(entry)
  if (own === undefined) return undefined
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    // A relative or empty entry searches the working directory, which the hook does not track.
    if (!path.isAbsolute(dir)) return undefined
    const file = path.join(dir, 'agent-chat')
    if (!fs.existsSync(file)) continue
    const realDir = realOf(dir)
    return realOf(file) === own && realDir !== undefined ? { file: own, dir: realDir } : undefined
  }
  return undefined
}

export const pathFindsOwnInstall = (env: NodeJS.ProcessEnv, entry: string | undefined): boolean =>
  ownInstall(env, entry) !== undefined

const WORKER_CONFIG_FILES = ['profiles', 'config.json', 'hooks.json', 'burndown.config.json']

// A worker that rewrites a profile or the config can drop its own denies (CC-1094); a coordinator edits them by design.
const workerConfigPaths = (env: NodeJS.ProcessEnv): string[] => {
  if (env.AGENT_CHAT_ROLE === 'coordinator') return []
  const fragments = WORKER_CONFIG_FILES.map(file => `.agent-chat/${file}`)
  const relocated = env.AGENT_CHAT_HOME
  return relocated
    ? [...fragments, ...WORKER_CONFIG_FILES.map(file => path.join(relocated, file))]
    : fragments
}

const LAUNCHER_KEY_FILES = ['launcher.key', 'launcher-keys']

// The per-host hello secrets (CC-1063) are owner-provisioned only, so every role is denied, coordinators included.
const launcherKeyPaths = (env: NodeJS.ProcessEnv): string[] => {
  const fragments = LAUNCHER_KEY_FILES.map(file => `.agent-chat/${file}`)
  const relocated = env.AGENT_CHAT_HOME
  return relocated ? [...fragments, ...LAUNCHER_KEY_FILES.map(file => path.join(relocated, file))] : fragments
}

export function guardContext(
  env: NodeJS.ProcessEnv,
  cwd: string,
  home: string,
  entry: string | undefined = process.argv[1],
): GuardContext {
  const terms = termsFile(env, home)
  const hooksDir = hooksDirOf(env as Record<string, string>)
  const install = ownInstall(env, entry)
  return {
    terms: loadTerms(terms),
    cwd,
    env,
    protectedPaths: [
      terms,
      'titan-egress/private-terms',
      '.agent-chat/git-hooks',
      ...(hooksDir === undefined ? [] : [hooksDir]),
      ...workerConfigPaths(env),
      ...launcherKeyPaths(env),
    ],
    readFile: readText,
    readAlias: aliasReader(env),
    readIncludedHooksPath: includedHooksPathReader(env),
    readGhAliases: ghAliasReader(env, readText),
    scansGhWrite: install !== undefined,
    ...(install === undefined ? {} : { install }),
  }
}

/** Claude Code's PreToolUse deny shape. */
export const denyOutput = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })

/** The deny for a call the guard could not check when it mentions git or gh; undefined for any other call. */
export const crashDenial = (raw: string): string | undefined =>
  MENTIONS_GIT.test(raw) ? denyOutput('leak-guard: the guard could not check this call. ' + DOCS) : undefined

/**
 * The hook's stdout for Claude Code's stdin, or '' to allow. A call the guard cannot read is
 * denied only when it mentions git or gh, so a guard bug cannot block every other command.
 */
export function pretoolDecision(
  raw: string,
  build: (cwd: string) => GuardContext,
  onFailOpen: FailOpen = () => undefined,
): string {
  try {
    const input = JSON.parse(raw) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
    if (typeof input.tool_name !== 'string') throw new Error('no tool_name')
    const ctx = build(typeof input.cwd === 'string' ? input.cwd : process.cwd())
    const reason = checkToolCall(input.tool_name, input.tool_input, ctx)
    return reason === undefined ? '' : denyOutput(reason)
  } catch (err) {
    const denied = crashDenial(raw)
    if (denied !== undefined) return denied
    onFailOpen(crashCause(err))
    return ''
  }
}
