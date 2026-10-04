import fs from 'node:fs'
import path from 'node:path'
import { matchRules, parseTerms, type TermRule } from '@titan-design/egress-scan'
import {
  aliasReader,
  CONFIG_ENV,
  configEnvVars,
  gitCall,
  gitGlobals,
  gitOptions,
  quoted,
  UNSURE_CALL,
  shellAlias,
  splitAlias,
  type GitCall,
  type Overrides,
  type ReadAlias,
} from './git-alias.js'
import { crashCause, type FailOpen } from './failopen.js'
import { gitScripts, type ScriptSpan } from './git-scripts.js'
import { classifyApiRead } from './gh-api-read.js'
import {
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
  HOLE,
  LIVE,
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
  /** Absolute paths and path fragments an agent may not touch: the hook dir and the term list. */
  protectedPaths: readonly string[]
  readFile(file: string): string | undefined
  readAlias: ReadAlias
  readIncludedHooksPath: ReadIncludedHooksPath
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
  /** How many git aliases the guard has expanded to reach this command. */
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

const MAX_DEPTH = 6
const MAX_ALIASES = 4
const MAX_HIDDEN_STARTS = 64

export const REASONS = {
  noVerify: `leak-guard: git push --no-verify skips the pre-push leak scan. Push without it. ${DOCS}`,
  gitConfig: `leak-guard: git -c or --config-env on core.hooksPath or an alias would bypass the pre-push leak scan. ${DOCS}`,
  configWrite: `leak-guard: writing core.hooksPath, or an alias that skips hooks, is not allowed for agents. ${DOCS}`,
  gitConfigEnv: `leak-guard: setting, exporting or unsetting GIT_CONFIG_* would switch off the pre-push leak scan. ${DOCS}`,
  envClear: `leak-guard: env -i clears the variables that run the pre-push leak scan. ${DOCS}`,
  protectedPath: `leak-guard: the leak guard's hook directory and private term list are off limits to agents. ${DOCS}`,
  tooDeep: `leak-guard: the command nests shells too deeply to check. Run it more directly. ${DOCS}`,
  stdinBody: `leak-guard: a PR or issue body read from a pipe cannot be checked. Write it to a .md file in your worktree and post it with agent-chat gh-write -- <gh args> --body-file <path>. ${DOCS}`,
  unreadableBody: `leak-guard: this command's PR or issue text could not be read the way the shell will read it, so it was not checked. Use literal arguments and post the text with agent-chat gh-write -- <gh args> --body-file <path>, the file at a literal path in your worktree written by a quoted heredoc. ${DOCS}`,
  heredocBackslash: `leak-guard: a heredoc in this command holds a backslash, which a shell may rewrite: it joins a line that ends in one, and under an unquoted delimiter it escapes the next character. So this PR or issue text was not checked. Remove the backslash, or write the text to a file and pass --body-file. ${DOCS}`,
  hiddenCommand: `leak-guard: the command word is an expansion, so the guard cannot tell what this runs. Write git or gh out literally. ${DOCS}`,
  hiddenBody: `leak-guard: the command word is an expansion, so the guard cannot tell which directory or variables gh reads this PR or issue text with, and did not check it. Write the command out literally: agent-chat gh-write -- <gh args> --body-file <path>. ${DOCS}`,
  hiddenStarts: `leak-guard: this command line has more than ${MAX_HIDDEN_STARTS} command starts after expanded command words, more than the guard checks, and it may run git or gh. Split it into shorter Bash calls. ${DOCS}`,
  hiddenScript: `leak-guard: eval of text the guard cannot read, on a command line that names git or gh. Run the command directly. ${DOCS}`,
  missingTerms: `leak-guard: no private term list, so PR and issue text cannot be checked. Create ~/.config/titan-egress/private-terms, one term per line, chmod 600. ${DOCS}`,
  xargsOption: `leak-guard: xargs with an option this guard does not know, so it cannot tell which word is the command. Spell the option in full, or run the command without xargs. ${DOCS}`,
  unreadableTerms: `leak-guard: the private term list could not be read, so PR and issue text cannot be checked. ${DOCS}`,
  aliasEnv: `leak-guard: the guard cannot tell which directory or config this git command runs with, or which subcommand it names, so it cannot tell what a git alias here runs. Run the command the alias stands for, from a plain cd. ${DOCS}`,
  aliasDepth: `leak-guard: git aliases here expand more than 4 deep, so the guard cannot tell what this runs. Run the git command directly. ${DOCS}`,
  includePath: `leak-guard: git -c or --config-env on include.path or includeIf.*.path pulls in config that sets core.hooksPath or that the guard cannot read in time, or runs beside other commands or a redirect, which would bypass the pre-push leak scan. ${DOCS}`,
  gitConfigUnresolved: `leak-guard: git -c or --config-env with a key or value the guard cannot read, before a command that runs hooks, may set core.hooksPath or include.path and would bypass the pre-push leak scan. Spell the config out, or drop it. ${DOCS}`,
  gitValueSplits: `leak-guard: a git option or option value here is unquoted, and the shell may split it into several words, one of them an option such as -c core.hooksPath, so the guard cannot tell what git runs. Quote the value, as in git -C "$dir" fetch. ${DOCS}`,
  aliasHidden: `leak-guard: the command word is an expansion the line ties to git, so the guard cannot tell which alias lookup applies or what git runs. Write the command name out: git <subcommand>, not $cmd. ${DOCS}`,
  ghApiUnquoted: `leak-guard: this gh api call holds an unquoted expansion the shell may split into flags, such as -X or -f, so the guard cannot tell if it is a read. Quote the endpoint, as in gh api "repos/o/r/commits/$SHA/check-runs", or post a write with agent-chat gh-write -- api <args>. ${DOCS}`,
  ghApiRoute: `leak-guard: a gh api read with an argument the guard cannot resolve is allowed only alone on its line, beside assignments with literal values. Put the value in literally (gh api repos/o/r/commits/<sha>/check-runs), or run the gh api call on a line of its own with no pipe, redirect, $(...) or other command. ${DOCS}`,
  ghApiHost: `leak-guard: a gh api read with an argument the guard cannot resolve may go only to github.com, with no proxy variable. Drop the --hostname, GH_HOST or HTTPS_PROXY, HTTP_PROXY or ALL_PROXY setting, or put the value in literally. ${DOCS}`,
  nestedScript: `leak-guard: git runs a command here (rebase --exec, submodule foreach, bisect run or the like) that the guard cannot read. Write the command out literally. ${DOCS}`,
  writtenBody: `leak-guard: this command line writes a PR or issue body file and posts it, so the guard cannot scan a body that does not exist yet. Post it with agent-chat gh-write -- <gh args> --body-file <path>, which scans the file when it runs, from a literal path in your worktree; or write the file in one Bash call and post it in the next. ${DOCS}`,
  ghByPath: `leak-guard: gh called by path skips the agent's gh shim and the gh-write leak scan. Use bare gh for reads and agent-chat gh-write -- <gh args> for every GitHub write. ${DOCS}`,
  aliasWritten: `leak-guard: this command line writes git config and runs a git word that may be an alias, so the guard cannot tell what that alias will run. Write the config in one Bash call and run the alias in another. ${DOCS}`,
} as const

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ENV_EDITS = new Set(['export', 'unset', 'declare', 'typeset', 'readonly', 'local'])
const PREFIX_WORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time'])
const PLAIN_WRAPPERS = new Set(['command', 'builtin', 'nohup', 'noglob', 'nocorrect', 'coproc'])
const OPTION_WRAPPERS = ['exec', 'nice', 'caffeinate', 'timeout', 'repeat', 'xargs', 'env']
/** Every name unwrap or checkSimple acts on; a command that starts with another literal word runs nothing checked. */
const CHECKED_NAMES = new Set([
  ...PLAIN_WRAPPERS,
  ...OPTION_WRAPPERS,
  ...SHELLS,
  ...ENV_EDITS,
  ...['function', 'eval', 'git', 'gh', 'agent-chat'],
])
const XARGS_SHORT_VALUE = new Set('nILPdasEJRS')
const XARGS_LONG_VALUE = new Set([
  '--arg-file',
  '--delimiter',
  '--max-lines',
  '--max-args',
  '--max-chars',
  '--max-procs',
  '--process-slot-var',
])
const XARGS_LONG_FLAG = new Set([
  '--null',
  '--eof',
  '--replace',
  '--interactive',
  '--open-tty',
  '--no-run-if-empty',
  '--verbose',
  '--exit',
  '--show-limits',
  '--version',
  '--help',
])
const GIT_VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix'])

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/
const isGitConfigVar = (name: string | undefined): boolean => name !== undefined && /^GIT_CONFIG/.test(name)
const NO_VERIFY = /^--no-veri(?:f|fy)?$/
const MENTIONS_GIT = /\b(?:git|gh)\b|GIT_CONFIG/

/**
 * `chdir` is set when a wrapper such as `env -C` runs the command in another directory.
 * `assigns` are the command's own `NAME=value` words, and a bare `NAME` that `env -u` unsets.
 */
type Unwrapped = { words: string[]; chdir?: boolean; assigns: string[] } | { reason: string }

/** Strips assignments and wrappers such as `env`, `command` and `nice` down to the command that runs. */
function unwrap(words: readonly string[]): Unwrapped {
  let rest = words
  let at = 0
  let chdir = false
  const assigns: string[] = []
  for (;;) {
    const head = rest[at]
    if (head === undefined) return { words: rest.slice(at), chdir, assigns }
    const name = path.basename(head)
    const assigned = ASSIGNMENT.exec(head)?.[1]
    const next = wrapperEnd(rest, at, name)
    if (assigned !== undefined) {
      if (isGitConfigVar(assigned)) return { reason: REASONS.gitConfigEnv }
      assigns.push(head)
      at++
    } else if (PREFIX_WORDS.has(head)) at = dropOptions(rest, at + 1)
    else if (next !== undefined) at = next
    else if (name === 'xargs') {
      const after = dropXargsOptions(rest, at + 1)
      if (after === undefined) return { reason: REASONS.xargsOption }
      at = after
    } else if (name === 'env') {
      const env = unwrapEnv(rest, at + 1)
      if ('reason' in env) return env
      ;({ words: rest, at } = env)
      chdir ||= env.chdir === true
      assigns.push(...env.assigns)
    } else return { words: rest.slice(at), chdir, assigns }
  }
}

/** Where the command after a wrapper and its options starts; undefined when `name` is no such wrapper. */
function wrapperEnd(words: readonly string[], at: number, name: string): number | undefined {
  if (PLAIN_WRAPPERS.has(name)) return dropOptions(words, at + 1)
  if (name === 'exec') return dropOptions(words, at + 1, ['-a'])
  if (name === 'nice') return dropOptions(words, at + 1, ['-n'])
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

/** Returns where the command xargs runs starts, or undefined on a long option this guard does not know. */
function dropXargsOptions(words: readonly string[], i: number): number | undefined {
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a === '--') return i + 1
    if (!a.startsWith('-') || a === '-') break
    if (a.startsWith('--')) {
      const name = a.split('=')[0] as string
      if (XARGS_LONG_VALUE.has(name)) i += a.includes('=') ? 0 : 1
      else if (!XARGS_LONG_FLAG.has(name)) return undefined
    } else i += clusterValueWords(a)
  }
  return Math.min(i, words.length)
}

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

function unwrapEnv(args: readonly string[], i: number): EnvRun {
  let chdir = false
  const assigns: string[] = []
  for (; i < args.length; i++) {
    const a = args[i] as string
    const unset =
      a === '-u' || a === '--unset' ? args[++i] : (/^-u(.+)/.exec(a)?.[1] ?? /^--unset=(.*)/.exec(a)?.[1])
    if (isGitConfigVar(unset)) return { reason: REASONS.gitConfigEnv }
    if (unset !== undefined) {
      assigns.push(unset)
      continue
    }
    if (a === '-' || a === '--ignore-environment' || /^-[^-]*i/.test(a)) return { reason: REASONS.envClear }
    if (a === '-S' || a === '--split-string') {
      const split = parseShell(args[i + 1] ?? '')[0]?.marked ?? []
      return { words: [...split, ...args.slice(i + 2)], at: 0, assigns }
    }
    chdir ||= /^(?:-C|--chdir)/.test(a)
    if (a === '-C' || a === '--chdir' || a === '-P') i++
    else if (a === '--') return { words: args, at: i + 1, chdir, assigns }
    else if (!a.startsWith('-') && !ASSIGNMENT.test(a)) break
    else if (isGitConfigVar(ASSIGNMENT.exec(a)?.[1])) return { reason: REASONS.gitConfigEnv }
    else if (ASSIGNMENT.test(a)) assigns.push(a)
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
    checkAlias(run, ctx, scope, depth)
  )
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
    const eq = word.indexOf('=')
    const value = eq < 0 ? undefined : (resolveWord(word.slice(eq + 1), run.cmd, ctx, scope) ?? UNSURE)
    set.set(eq < 0 ? word : word.slice(0, eq), value)
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
  const rest = run.args.slice(call.at + 1)
  // A `!` body passes the include to every git it runs and may write the file before one reads it.
  if (alias.value.startsWith('!') && includesConfig(call.params)) return REASONS.includePath
  if (alias.value.startsWith('!'))
    return checkAt(
      shellAlias(alias.value.slice(1), rest),
      ctx,
      aliasShell(inner, call, env, alias.runsIn),
      depth + 1,
    )
  const value = splitAlias(alias.value)
  if (value === undefined) return undefined
  const words = [...run.args.slice(0, call.at), ...value, ...rest]
  return checkGitRun(
    { ...run, resolved: words, args: words, marked: words, literal: true, tied: true },
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
    const [, name = '', value = ''] = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word) ?? []
    return PROXY_VAR.test(name) || (name === 'GH_HOST' && value !== DEFAULT_HOST)
  })
  const hosts = words.flatMap((word, i) =>
    word === '--hostname' ? [words[i + 1]] : word.startsWith('--hostname=') ? [word.slice(11)] : [],
  )
  return assigned || hosts.some(host => host !== DEFAULT_HOST)
}

/**
 * A read the guard allows unread must not go where the shell's environment, which the guard cannot
 * read, sends it. So the line may hold only `gh api` calls and literal assignments: anything else,
 * such as `declare`, `read`, `export`, `env` or a compound, could set GH_HOST, a proxy or a home.
 */
function unreadableRoute(scope: Scope): string | undefined {
  const cmds = parseShell(scope.line)
  const plain = cmds.every(
    cmd =>
      !cmd.nested &&
      LINE_JOINS.has(cmd.before) &&
      LINE_JOINS.has(cmd.after) &&
      (literalAssignments(cmd) || plainApiCall(cmd)),
  )
  if (!plain) return REASONS.ghApiRoute
  return cmds.some(reroutes) ? REASONS.ghApiHost : undefined
}

/** The deny for a gh call with a word the guard cannot resolve; a quoted read-only `gh api` is the one exception. */
function unsureGh(
  kind: GhKind,
  marked: readonly string[],
  args: readonly (string | undefined)[],
  cmd: SimpleCommand,
  scope: Scope,
): string | undefined {
  const read = kind === 'api' ? classifyApiRead(marked, args, cmd.splits) : 'other'
  if (read === 'read') return unreadableRoute(scope)
  if (read === 'splits') return REASONS.ghApiUnquoted
  return unread(cmd.substitutions.flatMap(sub => sub.commands))
}

function checkGh(
  marked: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  defers = false,
): string | undefined {
  const kind = ghKind(marked)
  if (kind === 'other') return undefined
  const args = marked.map(word => resolveWord(word, cmd, ctx, scope))
  if (defers && deferredWritesOnlyBody(kind, args, cmd, ctx, scope))
    return checkDeferred(kind, args, cmd, ctx, scope)
  const unsure = kind === 'unknown' || !args.every(arg => arg !== undefined)
  if (unsure) return unsureGh(kind, marked, args, cmd, scope)
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

const ghWriteArgs = (args: readonly string[]): readonly string[] =>
  args.includes('--') ? args.slice(args.indexOf('--') + 1) : args.slice(1)

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
): string | undefined {
  const unwrapped = unwrap(functionBody(cmd.marked))
  if ('reason' in unwrapped) return unwrapped.reason
  const at = unwrapped.chdir ? { ...scope, cwd: undefined } : scope
  const marked = unwrapped.words.slice(1)
  const head = resolveWord(unwrapped.words[0] ?? '', cmd, ctx, at)
  if (head === undefined) {
    // An `env -S` split behind another expansion would rescan every suffix at each level.
    if (!outermost && !isTail(unwrapped.words, cmd.marked)) return REASONS.hiddenCommand
    return checkHidden(unwrapped.words, unwrapped.assigns, cmd, ctx, at, depth, outermost)
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
  if (name === 'gh') return head === 'gh' ? checkGh(marked, cmd, ctx, at) : REASONS.ghByPath
  if (name === 'agent-chat' && args[0] === 'gh-write') {
    const defers = head === 'agent-chat' && defersToGhWrite(cmd, unwrapped.assigns, ctx, at)
    return checkGh(ghWriteArgs(marked), cmd, ctx, at, defers)
  }
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
    sure ? (resolveWord(word.slice(word.indexOf('=') + 1), cmd, ctx, scope) ?? UNSURE) : UNSURE
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

function checkAt(command: string, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return REASONS.tooDeep
  if (ctx.protectedPaths.some(p => command.includes(p))) return REASONS.protectedPath
  const cdpath = scope.cdpath || command.includes('CDPATH')
  const namesGit = scope.namesGit || MENTIONS_GIT.test(command)
  const said = `${scope.said}\n${unreferenced(command)}`
  let at: Scope = { ...scope, cdpath, namesGit, said, env: scope.env && knownEnv(command, scope.env) }
  for (const cmd of parseShell(command)) {
    at = settle(cmd, at)
    const reason = checkSimple(cmd, ctx, at, depth)
    if (reason !== undefined) return reason
    at = advance(cmd, ctx, at)
  }
  return undefined
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
    ],
    readFile: readText,
    readAlias: aliasReader(env),
    readIncludedHooksPath: includedHooksPathReader(env),
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
