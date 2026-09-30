import { spawnSync } from 'node:child_process'
import path from 'node:path'

/**
 * Reads a git alias that was already in config when the agent started (TP-595), so the bypass
 * guard can re-check what `git <alias>` really runs. The lookup runs inside a PreToolUse hook,
 * so it is bounded by a timeout and never throws. A failed read allows the call.
 */

/** git runs a builtin before any alias of the same name. From `git --list-cmds=builtins`, git 2.50. */
const GIT_BUILTINS = new Set(
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

function gitOutput(args: readonly string[], dir: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const run = spawnSync('git', args, {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: ALIAS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return run.status === 0 ? run.stdout.replace(/\n$/, '') : undefined
  } catch {
    return undefined
  }
}

function withOverrides(base: NodeJS.ProcessEnv, overrides: Overrides): NodeJS.ProcessEnv {
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

const VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
])
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

/**
 * The alias lookup for `git <words>`; undefined for a builtin or a word or directory the guard cannot tell.
 * `inherited` are the `-c` and `--config-env` options of the git whose `!` alias runs this one.
 */
export function gitCall(
  words: readonly (string | undefined)[],
  cwd: string | undefined,
  inherited: readonly string[] = [],
): GitCall | undefined {
  let dir = cwd
  const params = [...inherited]
  const dirs: [string, string][] = []
  let i = 0
  for (; i < words.length; i++) {
    const word = words[i]
    if (word === undefined) return undefined
    if (!word.startsWith('-')) break
    const name = optionName(word)
    if (!VALUE_OPTS.has(name)) continue
    const value = optionValue(word, name, words[i + 1])
    if (value === undefined) return undefined
    if (name === word) i++
    if (name === '-C' && value !== '') dir = path.isAbsolute(value) ? value : dir && path.resolve(dir, value)
    if (name === '-c') params.push('-c', value)
    if (name === '--config-env') params.push(`--config-env=${value}`)
    if (DIR_ENV[name] !== undefined) dirs.push([name, value])
  }
  const sub = words[i]
  if (sub === undefined || dir === undefined || GIT_BUILTINS.has(sub)) return undefined
  const at = dir
  const dirEnv = Object.fromEntries(dirs.map(([name, value]) => [DIR_ENV[name], path.resolve(at, value)]))
  const globals = [...dirs.map(([name, value]) => `${name}=${value}`), ...params]
  return { sub, dir, globals, params, vars: configEnvVars(params), dirEnv, at: i }
}

const configEnvVars = (params: readonly string[]): string[] =>
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
const quoted = (word: string): string => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)
const POSITIONAL = /\$(?:\{([1-9@*])\}|([1-9@*]))/g

/** The command line a `!` alias runs: git passes the words after it as `$@` and appends `"$@"`. */
export function shellAlias(body: string, rest: readonly string[]): string {
  const all = rest.map(quoted).join(' ')
  const filled = body.replace(POSITIONAL, (_, braced?: string, bare?: string) => {
    const n = braced ?? bare ?? ''
    return n === '@' || n === '*' ? all : quoted(rest[Number(n) - 1] ?? '')
  })
  return rest.length === 0 ? filled : `${filled} ${all}`
}
