/**
 * Inputs that change which program git, gh or a shell runs without the guard reading it (TP-2376):
 * a shell's startup file, git's exec path, a repository template, and `safe.directory`, which lets
 * git read the config and hooks of a repository someone else owns.
 */
import { CLONE_OPTIONS, readConfigCall } from './git-programs.js'
import { isSet, optionSpec, parseOptions, type OptionSpec, type SubArgs } from './git-parse-options.js'

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
 * Variables that pick which program a command finds or which libraries the loader injects into
 * git (CC-1236). A literal value names files as any command line does, so it keeps its verdict;
 * a value the guard cannot read may point git anywhere, so it fails closed.
 */
export const SEARCH_ENV: ReadonlySet<string> = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_ORIGIN_PATH',
  'GCONV_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
])

/**
 * zsh's lowercase arrays tied to a SEARCH_ENV name: `path=($X $path)` sets PATH. The Bash tool's
 * shell here is zsh, so they count on every line. Only a word that names one as a variable counts,
 * since `path` is a common file name.
 */
export const ZSH_TIED_SEARCH_ENV: readonly string[] = ['path']

/**
 * Regex sources for whole variable names a shell turns straight into code it runs, so they set a
 * shell's startup as BASH_ENV does. Patterns rather than names, to fail closed on kin: bash's
 * exported functions (`BASH_FUNC_f%%`, and `BASH_FUNC_f()` from older patches), its option lists
 * (`SHELLOPTS=xtrace` expands `PS4`), every prompt bash, zsh, sh or ksh expands (`PS0`-`PS4`,
 * `PROMPT_COMMAND`, zsh's `PROMPT`, `PROMPT2`-`PROMPT4`, `PROMPT_EOL_MARK`, `RPROMPT`, `RPROMPT2`,
 * `RPS*` and `SPROMPT`), and the paths a shell loads functions or modules from. A lookalike such as
 * `PROMPTS` is no prompt, so the prompt patterns stop at a digit or an underscore suffix.
 */
export const SHELL_CODE_ENV: readonly string[] = [
  'BASH_FUNC_[^\\s=]*',
  'SHELLOPTS',
  'BASHOPTS',
  'PS[0-9]+',
  'PROMPT(?:[0-9]+|_\\w+)?',
  'RPROMPT[0-9]*',
  'RPS[0-9]+',
  'SPROMPT',
  'FPATH',
  'MODULE_PATH',
  'BASH_LOADABLES_PATH',
]

/**
 * Variables whose value loads or runs code in perl, ruby or python, which git's helpers
 * (`git send-email`, `git svn`) and a repository's hooks may be. `PYTHONSTARTUP` runs only in an
 * interactive python, and is listed to fail closed as `BASH_ENV` is. `NODE_OPTIONS` and the
 * module paths (`PYTHONPATH`, `PERL5LIB`, `RUBYLIB`, `NODE_PATH`) are left out: they are common on
 * build lines and are accepted gaps.
 */
export const INTERPRETER_CODE_ENV: readonly string[] = ['PERL5OPT', 'PERL5DB', 'RUBYOPT', 'PYTHONSTARTUP']

/** zsh imports a lowercase `prompt` into `PS1`; only zsh reads it, so it counts only on a zsh line. */
export const ZSH_IMPORTED_PROMPT_ENV: readonly string[] = ['prompt']

// A `zsh` word not inside a longer name (`oh-my-zsh`), or the user's `$SHELL`, which may be zsh.
const ZSH_RUN = /(?<![\w-])zsh\b|\$\{?SHELL\b/

/** Whether a command line may run zsh. */
export const runsZsh = (text: string): boolean => ZSH_RUN.test(text)

/**
 * Programs whose words never name a shell variable they assign, so a bare `PS1` given to them is
 * data. `printf` and zsh's `print` are left out: `-v` assigns the named variable.
 */
export const NAME_FREE_PROGRAMS: ReadonlySet<string> = new Set(['echo', 'grep', 'egrep', 'fgrep', 'rg'])

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
 * The builtins that create a repository and so copy a template, each with its options. `init-db`
 * is `init` under its old name; `git submodule` runs `git clone`, which reads only config and env.
 */
export const REPO_CREATORS: ReadonlyMap<string, OptionSpec> = new Map([
  ['init', INIT_OPTIONS],
  ['init-db', INIT_OPTIONS],
  ['clone', CLONE_OPTIONS],
])

/**
 * Whether a `REPO_CREATORS` builtin (`git init`, `init-db` or `clone`), given its words after the subcommand, takes a template from a
 * directory: true for `--template` (any unique prefix) with a non-empty or unread value, `option`
 * when an option is one the guard cannot match or a word before `--` that is no option's value is
 * unread: both commands read options anywhere, so that word may be `--template=<dir>`. An empty
 * value and `--no-template` use none.
 */
export function templateOption(sub: string, args: SubArgs): boolean | 'option' {
  const spec = REPO_CREATORS.get(sub)
  if (spec === undefined) return false
  const parsed = parseOptions(args, spec)
  if (parsed === undefined) return 'option'
  const value = parsed.options.get('template')
  const set =
    parsed.options.has('template') && (value === undefined || (typeof value === 'string' && value !== ''))
  if (set && !isSet(parsed, 'help')) return true
  return parsed.positionals.slice(0, parsed.beforeDashDash).includes(undefined) ? 'option' : false
}

/** Whether a git leading option sets the exec path; bare `--exec-path` only prints it. */
export const execPathOption = (word: string): boolean => word.startsWith('--exec-path=')
