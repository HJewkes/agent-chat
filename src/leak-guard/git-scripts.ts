/**
 * The words of a git command that git hands to a shell or runs as a program (TP-634), such as
 * `rebase --exec`, `submodule foreach` and `bisect run`. The pretool checks each one as a nested
 * command line. Reading an ordinary value as a script is harmless, so the rules lean that way.
 */

/** Words `from` to `to` of the command; the first one starts at `offset`, after an `=` or a short flag. */
export interface ScriptSpan {
  from: number
  to: number
  offset: number
}

/** A script git hands to a shell; any expansion in it but `vars`, which git sets, is unreadable (TP-2496). */
export interface GitScript extends ScriptSpan {
  vars: readonly string[]
}

export interface ScriptOptions {
  /** Long options whose value is a script; git takes any unambiguous prefix of them. */
  long: readonly string[]
  /** The short option whose value is a script. */
  short?: string
  /** Short options that take a value, which ends a cluster such as `-sx`. */
  shortValue?: string
  /** The value must be attached, as `-O<pager>` and `--open-files-in-pager=<pager>` must. */
  attached?: boolean
  /** The variables git sets for the script. */
  vars?: readonly string[]
}

const FILTERS = ['env', 'tree', 'index', 'parent', 'msg', 'commit', 'tag-name'].map(f => `--${f}-filter`)

/** What filter-branch exports for its filters: the commit and its author and committer. */
const FILTER_VARS = [
  'GIT_COMMIT',
  ...['AUTHOR', 'COMMITTER'].flatMap(who => ['NAME', 'EMAIL', 'DATE'].map(field => `GIT_${who}_${field}`)),
]

const OPTION_SCRIPTS: ReadonlyMap<string, ScriptOptions> = new Map(
  Object.entries({
    rebase: { long: ['--exec'], short: 'x', shortValue: 'sXCS' },
    difftool: { long: ['--extcmd'], short: 'x', shortValue: 't' },
    'filter-branch': { long: ['--setup', ...FILTERS], vars: FILTER_VARS },
    grep: { long: ['--open-files-in-pager'], short: 'O', shortValue: 'efmABC', attached: true },
    push: { long: ['--receive-pack', '--exec'], shortValue: 'o' },
    fetch: { long: ['--upload-pack'], shortValue: 'jo' },
    pull: { long: ['--upload-pack'], shortValue: 'jsXo' },
    clone: { long: ['--upload-pack'], short: 'u', shortValue: 'obcj' },
    'ls-remote': { long: ['--upload-pack'], short: 'u' },
    archive: { long: ['--exec'], shortValue: 'o' },
    'send-email': { long: ['--to-cmd', '--cc-cmd', '--header-cmd', '--sendmail-cmd'] },
  }),
)

/** The script after a long option: `--exec=<s>`, or `--exec <s>` unless the value must be attached. */
function longSpan(word: string, i: number, words: readonly string[], opts: ScriptOptions): ScriptSpan[] {
  const eq = word.indexOf('=')
  const name = eq < 0 ? word : word.slice(0, eq)
  if (name.length <= 2 || !opts.long.some(option => option.startsWith(name))) return []
  if (eq >= 0) return [{ from: i, to: i + 1, offset: eq + 1 }]
  return opts.attached || i + 1 >= words.length ? [] : [{ from: i + 1, to: i + 2, offset: 0 }]
}

/** The script in a short cluster such as `-ix <s>` or `-x<s>`; a value option before it ends the cluster. */
function shortSpan(word: string, i: number, words: readonly string[], opts: ScriptOptions): ScriptSpan[] {
  for (let k = 1; k < word.length; k++) {
    const c = word[k] as string
    if (c === opts.short) {
      if (k + 1 < word.length) return [{ from: i, to: i + 1, offset: k + 1 }]
      return opts.attached || i + 1 >= words.length ? [] : [{ from: i + 1, to: i + 2, offset: 0 }]
    }
    if (opts.shortValue?.includes(c)) return []
  }
  return []
}

/** The value spans of one option after the subcommand at `at`, read by git's parse-options rules. */
export function optionSpans(words: readonly string[], at: number, opts: ScriptOptions): ScriptSpan[] {
  const spans: ScriptSpan[] = []
  for (let i = at + 1; i < words.length && words[i] !== '--'; i++) {
    const word = words[i] as string
    if (word.startsWith('--')) spans.push(...longSpan(word, i, words, opts))
    else if (word.startsWith('-')) spans.push(...shortSpan(word, i, words, opts))
  }
  return spans
}

/** `git clone -c`/`--config <key>=<value>`, beside clone's other short options that take a value. */
export const CLONE_CONFIG: ScriptOptions = { long: ['--config'], short: 'c', shortValue: 'obuj' }

/** The variables `git submodule foreach` sets for its command. */
const FOREACH_VARS = ['name', 'sm_path', 'displaypath', 'sha1', 'toplevel']

/** The command after `foreach` or `run`, past the options git reads before it. */
function trailingSpan(words: readonly string[], verbAt: number, vars: readonly string[]): GitScript[] {
  let i = verbAt + 1
  while (i < words.length && (words[i] as string).startsWith('-')) i++
  return i < words.length ? [{ from: i, to: words.length, offset: 0, vars }] : []
}

/** `git submodule [--quiet] [--cached] foreach [--recursive] <command>`. */
function submoduleSpans(words: readonly string[], at: number): GitScript[] {
  let i = at + 1
  while (i < words.length && (words[i] as string).startsWith('-')) i++
  return words[i] === 'foreach' ? trailingSpan(words, i, FOREACH_VARS) : []
}

/** The scripts of `git <words>`, whose subcommand is at index `at`. */
export function gitScripts(words: readonly string[], at: number): GitScript[] {
  const sub = words[at]
  if (sub === 'submodule') return submoduleSpans(words, at)
  if (sub === 'bisect') return words[at + 1] === 'run' ? trailingSpan(words, at + 1, []) : []
  const opts = sub === undefined ? undefined : OPTION_SCRIPTS.get(sub)
  if (opts === undefined) return []
  return optionSpans(words, at, opts).map(span => ({ ...span, vars: opts.vars ?? [] }))
}

/** A `$` expansion, with the name of a plain `$name` or `${name}`, or a backquote. */
const EXPANSION = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))?|`/g

/**
 * Whether the script expands anything but the variables git sets for it. The guard cannot know
 * what the shell git starts finds there, so a program or `--no-verify` could hide in it. A
 * variable git sets counts only when no name character follows it: `${name}x` is a near miss.
 */
export function expandsUnknown(script: string, vars: readonly string[]): boolean {
  for (const match of script.matchAll(EXPANSION)) {
    if (match[0] === '$' && match.index + 1 === script.length) continue
    const name = match[1] ?? match[2]
    const next = script[match.index + match[0].length] ?? ''
    if (name === undefined || !vars.includes(name) || /\w/.test(next)) return true
  }
  return false
}
