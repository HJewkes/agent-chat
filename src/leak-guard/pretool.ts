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
  UNSURE_CALL,
  shellAlias,
  splitAlias,
  type GitCall,
  type Overrides,
  type ReadAlias,
} from './git-alias.js'
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
  /** The command line so far with `$NAME` references and quoting removed, to find names it may assign. */
  said: string
  /** The `-c` and `--config-env` options of the git whose `!` alias runs this command. */
  gitParams: readonly string[]
}

const UNSURE = Symbol('unsure')
type Setting = string | undefined | typeof UNSURE

const DOCS = 'See docs/leak-guard.md.'

export const REASONS = {
  noVerify: `leak-guard: git push --no-verify skips the pre-push leak scan. Push without it. ${DOCS}`,
  gitConfig: `leak-guard: git -c or --config-env on core.hooksPath or an alias would bypass the pre-push leak scan. ${DOCS}`,
  configWrite: `leak-guard: writing core.hooksPath, or an alias that skips hooks, is not allowed for agents. ${DOCS}`,
  gitConfigEnv: `leak-guard: setting, exporting or unsetting GIT_CONFIG_* would switch off the pre-push leak scan. ${DOCS}`,
  envClear: `leak-guard: env -i clears the variables that run the pre-push leak scan. ${DOCS}`,
  protectedPath: `leak-guard: the leak guard's hook directory and private term list are off limits to agents. ${DOCS}`,
  tooDeep: `leak-guard: the command nests shells too deeply to check. Run it more directly. ${DOCS}`,
  stdinBody: `leak-guard: a PR or issue body read from a pipe cannot be checked. Write it to a file and pass --body-file. ${DOCS}`,
  unreadableBody: `leak-guard: this command's PR or issue text could not be read the way the shell will read it, so it was not checked. Use literal arguments, a body file at a literal path and a quoted heredoc. ${DOCS}`,
  heredocBackslash: `leak-guard: a heredoc in this command holds a backslash, which a shell may rewrite: it joins a line that ends in one, and under an unquoted delimiter it escapes the next character. So this PR or issue text was not checked. Remove the backslash, or write the text to a file and pass --body-file. ${DOCS}`,
  hiddenCommand: `leak-guard: the command word is an expansion, so the guard cannot tell what this runs. Write git or gh out literally. ${DOCS}`,
  hiddenScript: `leak-guard: eval of text the guard cannot read, on a command line that names git or gh. Run the command directly. ${DOCS}`,
  missingTerms: `leak-guard: no private term list, so PR and issue text cannot be checked. Create ~/.config/titan-egress/private-terms, one term per line, chmod 600. ${DOCS}`,
  xargsOption: `leak-guard: xargs with an option this guard does not know, so it cannot tell which word is the command. Spell the option in full, or run the command without xargs. ${DOCS}`,
  unreadableTerms: `leak-guard: the private term list could not be read, so PR and issue text cannot be checked. ${DOCS}`,
  aliasEnv: `leak-guard: the guard cannot tell which directory or config this git command runs with, or which subcommand it names, so it cannot tell what a git alias here runs. Run the command the alias stands for, from a plain cd. ${DOCS}`,
  aliasDepth: `leak-guard: git aliases here expand more than 4 deep, so the guard cannot tell what this runs. Run the git command directly. ${DOCS}`,
  includePath: `leak-guard: git -c or --config-env on include.path or includeIf.*.path pulls in config that sets core.hooksPath, or config the guard cannot read, which would bypass the pre-push leak scan. ${DOCS}`,
  aliasWritten: `leak-guard: this command line writes git config and runs a git word that may be an alias, so the guard cannot tell what that alias will run. Write the config in one Bash call and run the alias in another. ${DOCS}`,
} as const

const MAX_DEPTH = 6
const MAX_ALIASES = 4

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ENV_EDITS = new Set(['export', 'unset', 'declare', 'typeset', 'readonly', 'local'])
const PREFIX_WORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time'])
const PLAIN_WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'noglob', 'nocorrect', 'coproc'])
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
  let rest = [...words]
  let chdir = false
  const assigns: string[] = []
  for (;;) {
    const head = rest[0]
    if (head === undefined) return { words: rest, chdir, assigns }
    const name = path.basename(head)
    const assigned = ASSIGNMENT.exec(head)?.[1]
    if (assigned !== undefined) {
      if (isGitConfigVar(assigned)) return { reason: REASONS.gitConfigEnv }
      assigns.push(head)
      rest = rest.slice(1)
    } else if (PREFIX_WORDS.has(head) || PLAIN_WRAPPERS.has(name)) rest = dropOptions(rest.slice(1))
    else if (name === 'nice') rest = dropOptions(rest.slice(1), ['-n'])
    else if (name === 'caffeinate') rest = dropOptions(rest.slice(1), ['-t', '-w'])
    else if (name === 'timeout' || name === 'repeat') rest = dropOptions(rest.slice(1), ['-s', '-k']).slice(1)
    else if (name === 'xargs') {
      const after = dropXargsOptions(rest.slice(1))
      if (after === undefined) return { reason: REASONS.xargsOption }
      rest = after
    } else if (name === 'env') {
      const env = unwrapEnv(rest.slice(1))
      if ('reason' in env) return env
      rest = env.words
      chdir ||= env.chdir === true
      assigns.push(...env.assigns)
    } else return { words: rest, chdir, assigns }
  }
}

function dropOptions(words: string[], withValue: readonly string[] = []): string[] {
  let i = 0
  while (i < words.length && (words[i] as string).startsWith('-') && words[i] !== '-') {
    i += withValue.includes(words[i] as string) ? 2 : 1
  }
  return words.slice(i)
}

/** Returns the command xargs runs, or undefined on a long option this guard does not know. */
function dropXargsOptions(words: string[]): string[] | undefined {
  let i = 0
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a === '--') return words.slice(i + 1)
    if (!a.startsWith('-') || a === '-') break
    if (a.startsWith('--')) {
      const name = a.split('=')[0] as string
      if (XARGS_LONG_VALUE.has(name)) i += a.includes('=') ? 0 : 1
      else if (!XARGS_LONG_FLAG.has(name)) return undefined
    } else i += clusterValueWords(a)
  }
  return words.slice(i)
}

/** A short-flag cluster takes the next word only when its first value letter ends it. */
function clusterValueWords(cluster: string): number {
  for (let k = 1; k < cluster.length; k++) {
    if (XARGS_SHORT_VALUE.has(cluster[k] as string)) return k === cluster.length - 1 ? 1 : 0
    if ('ile'.includes(cluster[k] as string)) return 0
  }
  return 0
}

function unwrapEnv(args: string[]): Unwrapped {
  let i = 0
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
    if (a === '-S' || a === '--split-string')
      return { words: [...(parseShell(args[i + 1] ?? '')[0]?.marked ?? []), ...args.slice(i + 2)], assigns }
    chdir ||= /^(?:-C|--chdir)/.test(a)
    if (a === '-C' || a === '--chdir' || a === '-P') i++
    else if (a === '--') return { words: args.slice(i + 1), chdir, assigns }
    else if (!a.startsWith('-') && !ASSIGNMENT.test(a)) break
    else if (isGitConfigVar(ASSIGNMENT.exec(a)?.[1])) return { reason: REASONS.gitConfigEnv }
    else if (ASSIGNMENT.test(a)) assigns.push(a)
  }
  return { words: args.slice(i), chdir, assigns }
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
  assigns: readonly string[]
  cmd: SimpleCommand
  /** The command word is git, not an expansion that may be git. */
  literal: boolean
}

function gitRun(
  marked: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  literal: boolean,
): GitRun {
  const resolved = marked.map(word => resolveWord(word, cmd, ctx, scope))
  return { resolved, args: marked.map(unmark), assigns, cmd, literal }
}

const NAMES_GIT = /\bgit\b/

/** A lookup the guard cannot make denies where the command is git, or may be git on a line that names git. */
const unsure = (run: GitRun, scope: Scope): string | undefined =>
  run.literal || NAMES_GIT.test(scope.said) ? REASONS.aliasEnv : undefined

/** The one boundary every command that is or may be git passes: git's own options, the config they include, then its alias. */
function checkGitRun(run: GitRun, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  return checkGit(run.args) ?? checkInclude(run, ctx, scope) ?? checkAlias(run, ctx, scope, depth)
}

const MENTIONS_INCLUDE = /include/i

/** Reads the config files the command's own `-c include.path` and `includeIf.*.path` pull in, where it runs. */
function checkInclude(run: GitRun, ctx: GuardContext, scope: Scope): string | undefined {
  if (!run.args.some(arg => MENTIONS_INCLUDE.test(arg))) return undefined
  const cannotRead = run.literal || NAMES_GIT.test(scope.said) ? REASONS.includePath : undefined
  const options = gitOptions(run.resolved, scope.cwd)
  if (options === UNSURE_CALL || !options.sure) return cannotRead
  if (!includesConfig(options.params)) return undefined
  const env = aliasEnv(run, configEnvVars(options.params), ctx, scope)
  if (options.dir === undefined || env === undefined) return cannotRead
  return ctx.readIncludedHooksPath(options.dir, gitGlobals(options), env) ? REASONS.includePath : undefined
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
  if (call === UNSURE_CALL) return unsure(run, scope)
  const env = aliasEnv(run, call.vars, ctx, scope)
  if (env === undefined) return unsure(run, scope)
  const alias = ctx.readAlias(call.sub, call.dir, call.globals, env)
  if (alias === undefined) return undefined
  if (scope.aliases >= MAX_ALIASES) return REASONS.aliasDepth
  const inner = { ...scope, aliases: scope.aliases + 1 }
  const rest = run.args.slice(call.at + 1)
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
  return checkGitRun({ ...run, resolved: words, args: words, literal: true }, ctx, inner, depth)
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
function ghKind(marked: readonly string[]): GhKind {
  const group = marked[0] ?? ''
  if (group.includes(LIVE)) return 'unknown'
  if (group === 'api') return 'api'
  if (group !== 'pr' && group !== 'issue') return 'other'
  const verb = ghVerb(marked.slice(1))
  if (verb.includes(LIVE)) return 'unknown'
  return GH_TEXT_VERBS.has(verb) ? 'pr' : 'other'
}

const longValue = (arg: string, name: string): string | undefined =>
  arg === name ? '' : arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined

/** gh takes `-dF file`, a short flag behind other short flags, as well as `-F file` and `-Ffile`. */
function shortValue(arg: string, name: string): string | undefined {
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

function prSources(args: readonly string[]): Sources {
  const inline = [
    ...flagValues(args, ['--title', '--subject', '-t']).map(text => ({ label: 'title', text })),
    ...flagValues(args, ['--body', '-b']).map(text => ({ label: 'body', text })),
  ]
  const files = flagValues(args, ['--body-file', '-F']).map(file => ({ label: 'body', file }))
  return { inline, files }
}

function apiSources(args: readonly string[]): Sources {
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
function isMerge(args: readonly string[]): boolean {
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

function checkGh(
  marked: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
): string | undefined {
  const kind = ghKind(marked)
  if (kind === 'other') return undefined
  const args = marked.map(word => resolveWord(word, cmd, ctx, scope))
  const unsure = kind === 'unknown' || !args.every(arg => arg !== undefined)
  if (unsure) return unread(cmd.substitutions.flatMap(sub => sub.commands))
  const sources = kind === 'api' ? apiSources(args) : prSources(args)
  if (sources.inline.length + sources.files.length === 0) return undefined
  const collected = collect(sources, cmd, ctx, scope)
  if ('reason' in collected) return collected.reason
  if (ctx.terms.kind === 'unreadable') return REASONS.unreadableTerms
  if (ctx.terms.kind === 'missing' && MISSING_TERMS_REFUSES && !isMerge(args)) return REASONS.missingTerms
  const found = findingsIn(collected.texts, ctx.terms.kind === 'ok' ? ctx.terms.rules : [])
  if (found.length === 0) return undefined
  return `leak-guard: this text would publish private data (${found.join('; ')}). Remove the flagged text and retry; the guard never prints what matched. ${DOCS}`
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
 * It may also expand to nothing or to a wrapper, so the words after it are checked as a command.
 */
function checkHidden(
  marked: readonly string[],
  assigns: readonly string[],
  cmd: SimpleCommand,
  ctx: GuardContext,
  scope: Scope,
  depth: number,
): string | undefined {
  const viaWrite = unmark(marked[0] ?? '') === 'gh-write' && postsText(ghWriteArgs(marked))
  if (postsText(marked) || viaWrite) return REASONS.hiddenCommand
  const words = marked.map(unmark)
  const unseen = { ...scope, cwd: undefined, env: undefined }
  return (
    checkSimple({ ...cmd, words, marked: [...marked] }, ctx, unseen, depth) ??
    checkGitRun(gitRun(marked, assigns, cmd, ctx, scope, false), ctx, scope, depth)
  )
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

function checkSimple(cmd: SimpleCommand, ctx: GuardContext, scope: Scope, depth: number): string | undefined {
  const unwrapped = unwrap(cmd.marked)
  if ('reason' in unwrapped) return unwrapped.reason
  const at = unwrapped.chdir ? { ...scope, cwd: undefined } : scope
  const marked = unwrapped.words.slice(1)
  const head = resolveWord(unwrapped.words[0] ?? '', cmd, ctx, at)
  if (head === undefined) return checkHidden(marked, unwrapped.assigns, cmd, ctx, at, depth)
  const args = marked.map(unmark)
  const name = path.basename(head)
  if (SHELLS.has(name)) return checkShell(args, cmd.stdin, ctx, at, depth)
  if (name === 'eval') return checkEval(marked, cmd, ctx, at, depth)
  if (name === 'git')
    return checkGitRun(gitRun(marked, unwrapped.assigns, cmd, ctx, at, true), ctx, at, depth)
  if (name === 'gh') return checkGh(marked, cmd, ctx, at)
  if (name === 'agent-chat' && args[0] === 'gh-write') return checkGh(ghWriteArgs(marked), cmd, ctx, at)
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
    said: '',
    gitParams: [],
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

export function guardContext(env: NodeJS.ProcessEnv, cwd: string, home: string): GuardContext {
  const terms = termsFile(env, home)
  const hooksDir = hooksDirOf(env as Record<string, string>)
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

/**
 * The hook's stdout for Claude Code's stdin, or '' to allow. A call the guard cannot read is
 * denied only when it mentions git or gh, so a guard bug cannot block every other command.
 */
export function pretoolDecision(raw: string, build: (cwd: string) => GuardContext): string {
  try {
    const input = JSON.parse(raw) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
    if (typeof input.tool_name !== 'string') throw new Error('no tool_name')
    const ctx = build(typeof input.cwd === 'string' ? input.cwd : process.cwd())
    const reason = checkToolCall(input.tool_name, input.tool_input, ctx)
    return reason === undefined ? '' : denyOutput(reason)
  } catch {
    return MENTIONS_GIT.test(raw)
      ? denyOutput('leak-guard: the guard could not check this call. ' + DOCS)
      : ''
  }
}
