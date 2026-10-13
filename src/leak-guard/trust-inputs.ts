/**
 * Inputs that change which program git, gh or a shell runs without the guard reading it (TP-2376):
 * a shell's startup file, git's exec path, a repository template, and `safe.directory`, which lets
 * git read the config and hooks of a repository someone else owns.
 */
import { CLONE_OPTIONS, readConfigCall } from './git-programs.js'
import { isSet, optionSpec, parseOptions, type SubArgs } from './git-parse-options.js'

/** Which trust input an environment variable sets. */
export type TrustEnv = 'shellStartup' | 'execPath' | 'templateDir'

/** Which trust input a config key sets. */
export type TrustKey = 'safeDirectory' | 'templateDir'

/**
 * Variables that make a shell source a file (`BASH_ENV` for bash, `ENV` for sh in POSIX mode,
 * `ZDOTDIR` for zsh's startup files), move git's helper programs, or give git a template.
 */
export const TRUST_ENV: ReadonlyMap<string, TrustEnv> = new Map([
  ['BASH_ENV', 'shellStartup'],
  ['ENV', 'shellStartup'],
  ['ZDOTDIR', 'shellStartup'],
  ['GIT_EXEC_PATH', 'execPath'],
  ['GIT_TEMPLATE_DIR', 'templateDir'],
])

/**
 * Regex sources for whole variable names a shell turns straight into code it runs, so they set a
 * shell's startup as BASH_ENV does. Patterns rather than names, to fail closed on kin: bash's
 * exported functions (`BASH_FUNC_f%%`, and `BASH_FUNC_f()` from older patches), its option lists
 * (`SHELLOPTS=xtrace` expands `PS4`), every prompt bash, zsh, sh or ksh expands (`PS0`-`PS4`,
 * `PROMPT_COMMAND`, zsh's `PROMPT*`, `RPROMPT*`, `RPS*` and `SPROMPT`), and the paths a shell loads
 * functions or modules from.
 */
export const SHELL_CODE_ENV: readonly string[] = [
  'BASH_FUNC_[^\\s=]*',
  'SHELLOPTS',
  'BASHOPTS',
  'PS[0-9]+',
  'PROMPT\\w*',
  'RPROMPT\\w*',
  'RPS[0-9]+',
  'SPROMPT',
  'FPATH',
  'MODULE_PATH',
  'BASH_LOADABLES_PATH',
]

// git reads both keys only without a subsection, and section and key names case-insensitively.
const TRUST_KEYS: Readonly<Record<string, TrustKey>> = {
  'safe.directory': 'safeDirectory',
  'init.templatedir': 'templateDir',
}

/** The trust input a `-c`, `--config-env` or `git config` key sets, if any. */
export const trustKey = (key: string): TrustKey | undefined => TRUST_KEYS[key.toLowerCase()]

// Sections a renamed section may land in and so hold one of TRUST_KEYS; a subsection only over-denies.
const TRUST_SECTIONS: readonly [RegExp, TrustKey][] = [
  [/^safe(?:[."\s]|$)/i, 'safeDirectory'],
  [/^init(?:[."\s]|$)/i, 'templateDir'],
]

function renameTarget(names: readonly (string | undefined)[]): TrustKey | 'option' | undefined {
  const target = names[1]
  if (names.includes(undefined) || target === undefined) return 'option'
  return TRUST_SECTIONS.find(([section]) => section.test(target))?.[1]
}

/**
 * What a `git config` call, given its words after `config`, writes among the trust keys: the key's
 * input for a set, the target section's for a rename, `option` when the guard cannot read the call,
 * its key or a section name. Reads and unsets write none.
 */
export function trustConfigWrite(args: SubArgs): TrustKey | 'option' | undefined {
  const call = readConfigCall(args)
  if (call.mode === 'option') return 'option'
  if (call.mode === 'rename') return renameTarget(call.names)
  if (call.mode === 'other') return undefined
  return call.key === undefined ? 'option' : trustKey(call.key)
}

/**
 * `git init`'s options, from `git init -h` on git 2.53. `--shared[=<permissions>]` takes its value
 * only attached, so it reads as a flag.
 */
export const INIT_OPTIONS = optionSpec(
  `[no-]template= [no-]bare shared q:[no-]quiet [no-]separate-git-dir= b:[no-]initial-branch=
  [no-]object-format= [no-]ref-format=`,
)

/**
 * Whether `git init` or `git clone`, given its words after the subcommand, takes a template from a
 * directory: true for `--template` (any unique prefix) with a non-empty or unread value, `option`
 * when an option is one the guard cannot match or a word before `--` that is no option's value is
 * unread: both commands read options anywhere, so that word may be `--template=<dir>`. An empty
 * value and `--no-template` use none.
 */
export function templateOption(sub: 'init' | 'clone', args: SubArgs): boolean | 'option' {
  const parsed = parseOptions(args, sub === 'init' ? INIT_OPTIONS : CLONE_OPTIONS)
  if (parsed === undefined) return 'option'
  const value = parsed.options.get('template')
  const set =
    parsed.options.has('template') && (value === undefined || (typeof value === 'string' && value !== ''))
  if (set && !isSet(parsed, 'help')) return true
  return parsed.positionals.slice(0, parsed.beforeDashDash).includes(undefined) ? 'option' : false
}

/** Whether a git leading option sets the exec path; bare `--exec-path` only prints it. */
export const execPathOption = (word: string): boolean => word.startsWith('--exec-path=')
