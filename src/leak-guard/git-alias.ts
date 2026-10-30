import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import path from 'node:path'

/**
 * Reads a git alias that was already in config when the agent started (TP-595), so the bypass
 * guard can re-check what `git <alias>` really runs. The lookup runs inside a PreToolUse hook,
 * so it is bounded by a timeout and never throws. A failed read allows the call.
 */

/** git runs a builtin before any alias of the same name. From `git --list-cmds=builtins`, git 2.50. */
export const GIT_BUILTINS = new Set(
  `add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr
  check-ignore check-mailmap check-ref-format checkout checkout--worker checkout-index cherry
  cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential
  credential-cache credential-cache--daemon credential-store describe diagnose diff diff-files
  diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack fmt-merge-msg
  for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc get-tar-commit-id
  grep hash-object help hook index-pack init init-db interpret-trailers log ls-files ls-remote
  ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-ours
  merge-recursive merge-recursive-ours merge-recursive-theirs merge-subtree merge-tree mktag mktree
  multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id pickaxe prune
  prune-packed pull push range-diff read-tree rebase receive-pack reflog refs remote remote-ext
  remote-fd repack replace replay rerere reset restore rev-list rev-parse revert rm send-pack
  shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace
  submodule--helper switch symbolic-ref tag unpack-file unpack-objects update-index update-ref
  update-server-info upload-archive upload-archive--writer upload-pack var verify-commit
  verify-pack verify-tag version whatchanged worktree write-tree`.split(/\s+/),
)

export interface AliasValue {
  value: string
  /** The directory a `!` alias runs in: git moves to the top of the work tree first. */
  runsIn: string
}

/** Env values the command sets over the hook's own; undefined unsets the name. */
export type Overrides = Readonly<Record<string, string | undefined>>

/** `globals` are the git options that choose which config is read, `env` the command's changes to it. */
export type ReadAlias = (
  word: string,
  dir: string,
  globals: readonly string[],
  env: Overrides,
) => AliasValue | undefined

/** Variables that change which config files git reads; `GIT_CONFIG` also stands for every `GIT_CONFIG_*`. */
export const CONFIG_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'HOME',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
]

export const ALIAS_TIMEOUT_MS = 1000

// Node's spawnSync honours `detached` (its own process group), though @types/node leaves it out.
const OWN_GROUP = { detached: true }

/**
 * Runs git with the hook's timeout. spawnSync's timeout kills only its direct child, so a real git
 * behind a wrapper script, blocked on a FIFO include, outlived the hook (CC-1673). git runs as the
 * leader of its own group, and a timeout kills the whole group.
 */
export function spawnGitBounded(
  args: readonly string[],
  dir: string,
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  const run = spawnSync('git', args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: ALIAS_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...OWN_GROUP,
  })
  if (run.pid && (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') killGroup(run.pid)
  return run
}

function killGroup(leader: number): void {
  try {
    process.kill(-leader, 'SIGKILL')
  } catch {
    // ESRCH: the leader was the group's last member.
  }
}

function gitOutput(args: readonly string[], dir: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const run = spawnGitBounded(args, dir, env)
    return run.status === 0 ? run.stdout.replace(/\n$/, '') : undefined
  } catch {
    return undefined
  }
}

export function withOverrides(base: NodeJS.ProcessEnv, overrides: Overrides): NodeJS.ProcessEnv {
  const env = { ...base, ...overrides }
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name]
  return env
}

export const aliasReader =
  (base: NodeJS.ProcessEnv): ReadAlias =>
  (word, dir, globals, overrides) => {
    const env = withOverrides(base, overrides)
    const value = gitOutput([...globals, 'config', '--get', `alias.${word}`], dir, env)
    if (value === undefined) return undefined
    if (!value.startsWith('!')) return { value, runsIn: dir }
    return { value, runsIn: gitOutput([...globals, 'rev-parse', '--show-toplevel'], dir, env) ?? dir }
  }

export interface GitCall {
  sub: string
  dir: string
  globals: string[]
  /** The `-c` and `--config-env` options, which git passes on to the commands a `!` alias runs. */
  params: string[]
  /** The variables `--config-env` reads its values from. */
  vars: string[]
  /** `--git-dir` and `--work-tree` as the env git exports to a `!` alias. */
  dirEnv: Record<string, string>
  /** The index of the subcommand word. */
  at: number
}

/**
 * git's own options before the subcommand that take the next word as their value, other than `-c`
 * and `--config-env`, from git.c on git 2.53 (`--super-prefix` for older git). A missing one makes
 * its value read as the subcommand (TP-2371).
 */
export const GIT_VALUE_OPTS: ReadonlySet<string> = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--attr-source',
  '--shallow-file',
])
const VALUE_OPTS = new Set([...GIT_VALUE_OPTS, '-c', '--config-env'])
/** git's rule for a config variable name, so any other word cannot be an alias. */
export const ALIAS_NAME = /^[A-Za-z][A-Za-z0-9-]*$/
const DIR_ENV: Record<string, string> = { '--git-dir': 'GIT_DIR', '--work-tree': 'GIT_WORK_TREE' }

function optionName(word: string): string {
  if (/^-c./.test(word)) return '-c'
  const eq = word.indexOf('=')
  return word.startsWith('--') && eq > 0 ? word.slice(0, eq) : word
}

function optionValue(word: string, name: string, next: string | undefined): string | undefined {
  if (name === word) return next
  return name === '-c' ? word.slice(2) : word.slice(name.length + 1)
}

/** A git word the shell expands in a way the guard cannot tell, or a directory it cannot tell. */
export const UNSURE_CALL = 'unsure'

/** git's options before the subcommand; `dir` is undefined and `sure` false where a value cannot be told. */
export interface GitOptions {
  dir: string | undefined
  sure: boolean
  params: string[]
  dirs: [string, string][]
  /** The index of the first word that is not an option. */
  at: number
}

/** git's options in `words`, or UNSURE_CALL when a word before the subcommand cannot be told. */
export function gitOptions(
  words: readonly (string | undefined)[],
  cwd: string | undefined,
  inherited: readonly string[] = [],
): GitOptions | typeof UNSURE_CALL {
  let dir = cwd
  let sure = true
  const params = [...inherited]
  const dirs: [string, string][] = []
  let i = 0
  for (; i < words.length; i++) {
    const word = words[i]
    if (word === undefined) return UNSURE_CALL
    if (!word.startsWith('-')) break
    const name = optionName(word)
    if (!VALUE_OPTS.has(name)) continue
    const value = optionValue(word, name, words[i + 1])
    if (name === word) i++
    if (value === undefined) {
      if (name === '-C') dir = undefined
      else sure = false
      continue
    }
    if (name === '-C' && value !== '') dir = path.isAbsolute(value) ? value : dir && path.resolve(dir, value)
    if (name === '-c') params.push('-c', value)
    if (name === '--config-env') params.push(`--config-env=${value}`)
    if (DIR_ENV[name] !== undefined) dirs.push([name, value])
  }
  return { dir, sure, params, dirs, at: i }
}

/** The options that choose which config git reads, as the lookup passes them to git. */
export const gitGlobals = ({ dirs, params }: GitOptions): string[] => [
  ...dirs.map(([name, value]) => `${name}=${value}`),
  ...params,
]

/**
 * The alias lookup for `git <words>`: undefined when there is nothing to look up, a builtin or no
 * subcommand, and UNSURE_CALL when the subcommand, an option or the directory cannot be told.
 * `inherited` are the `-c` and `--config-env` options of the git whose `!` alias runs this one.
 */
export function gitCall(
  words: readonly (string | undefined)[],
  cwd: string | undefined,
  inherited: readonly string[] = [],
): GitCall | typeof UNSURE_CALL | undefined {
  const options = gitOptions(words, cwd, inherited)
  if (options === UNSURE_CALL) return UNSURE_CALL
  const { dir, sure, params, dirs, at: i } = options
  const sub = words[i]
  if (i >= words.length || (sub !== undefined && (GIT_BUILTINS.has(sub) || !ALIAS_NAME.test(sub))))
    return undefined
  if (sub === undefined || dir === undefined || !sure) return UNSURE_CALL
  const at = dir
  const dirEnv = Object.fromEntries(dirs.map(([name, value]) => [DIR_ENV[name], path.resolve(at, value)]))
  return { sub, dir, globals: gitGlobals(options), params, vars: configEnvVars(params), dirEnv, at: i }
}

export const configEnvVars = (params: readonly string[]): string[] =>
  params.filter(p => p.startsWith('--config-env=')).map(p => p.slice(p.lastIndexOf('=') + 1))

/** An alias value split the way git splits it: blanks separate words, quotes and backslashes group them. */
export function splitAlias(value: string): string[] | undefined {
  const words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string
    if (quote === undefined && /\s/.test(c)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else if (c === quote) quote = undefined
    else if (quote === undefined && (c === '"' || c === "'")) [quote, word] = [c, word ?? '']
    else if (c === '\\' && quote !== "'") word = (word ?? '') + (value[++i] ?? '')
    else word = (word ?? '') + c
  }
  if (word !== undefined) words.push(word)
  return quote === undefined ? words : undefined
}

const PLAIN_WORD = /^[\w@%+=:,./-]+$/
export const quoted = (word: string): string =>
  PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
const POSITIONAL = /\$(?:\{([1-9@*])\}|([1-9@*]))/g

/** The command line a `!` alias runs: git passes the words after it as `$@` and appends `"$@"`. */
export function shellAlias(body: string, rest: readonly string[]): string {
  const filled = fillPositionals(body, rest)
  return rest.length === 0 ? filled : `${filled} ${rest.map(quoted).join(' ')}`
}

// `${N}` fills exactly; any other brace form (`${1:-x}`, `${@:1}`, `${1#x}`, `${#1}`, `${!1}`, `${10}`) does not.
const BRACED = /^\$\{[#!]?([0-9@*])[^}]*\}/
const EXACT = /^\$\{[1-9@*]\}/
const BARE = /^\$([1-9@*])/

/** One read of a positional in a shell body: which, inside double quotes, and with a modifier. */
export interface PositionalUse {
  name: string
  quoted: boolean
  modified: boolean
}

function positionalAt(text: string, quoted: boolean): PositionalUse | undefined {
  const braced = BRACED.exec(text)
  if (braced !== null) return { name: braced[1] ?? '', quoted, modified: !EXACT.test(text) }
  const bare = BARE.exec(text)
  return bare === null ? undefined : { name: bare[1] ?? '', quoted, modified: false }
}

/** The index of the `'` that closes a `$'...'` string opened before `from`. */
function ansiEnd(body: string, from: number): number {
  for (let j = from; j < body.length; j++) {
    if (body[j] === '\\') j++
    else if (body[j] === "'") return j
  }
  return body.length
}

/** Every positional a shell body reads, outside single quotes and `$'...'` strings. */
export function positionalUses(body: string): PositionalUse[] {
  const uses: PositionalUse[] = []
  let quote: string | undefined
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote === "'") quote = c === "'" ? undefined : quote
    else if (c === '\\') i++
    else if (quote === undefined && body.startsWith("$'", i)) i = ansiEnd(body, i + 2)
    else if (c === '"') quote = quote === '"' ? undefined : '"'
    else if (c === "'" && quote === undefined) quote = "'"
    else if (c === '$') {
      const use = positionalAt(body.slice(i), quote === '"')
      if (use !== undefined) uses.push(use)
    }
  }
  return uses
}

/** A body whose arguments the guard cannot fill before they are known: a quoted or modified positional. */
export const unfillableAtSet = (body: string): boolean =>
  positionalUses(body).some(use => use.quoted || use.modified)

const FILL_PLAIN = /^[A-Za-z0-9_./:=@%+-]+$/

/**
 * Whether `fillPositionals` may misread the body. It fills each argument as one single-quoted
 * word, which matches `sh -c` only for a plain word: unquoted, the shell splits and globs an
 * argument; inside double quotes it keeps the quotes literally, and `"$@"` makes one word per
 * argument. A modified positional (`${1:-x}`) is not filled at all. So it is safe only with no
 * modifier, every argument a plain word, and a quoted `"$@"` given exactly one.
 */
export function fillsUnsafely(body: string, rest: readonly string[]): boolean {
  const uses = positionalUses(body)
  if (uses.length === 0) return false
  if (uses.some(use => use.modified) || rest.some(arg => !FILL_PLAIN.test(arg))) return true
  return uses.some(use => use.quoted && use.name === '@') && rest.length !== 1
}

/** A shell body with `$1`, `$@` and their kin replaced by the quoted words they stand for. */
export function fillPositionals(body: string, rest: readonly string[]): string {
  const all = rest.map(quoted).join(' ')
  return body.replace(POSITIONAL, (_, braced?: string, bare?: string) => {
    const n = braced ?? bare ?? ''
    return n === '@' || n === '*' ? all : quoted(rest[Number(n) - 1] ?? '')
  })
}
