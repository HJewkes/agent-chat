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

interface ScriptOptions {
  /** Long options whose value is a script; git takes any unambiguous prefix of them. */
  long: readonly string[]
  /** The short option whose value is a script. */
  short?: string
  /** Short options that take a value, which ends a cluster such as `-sx`. */
  shortValue?: string
  /** The value must be attached, as `-O<pager>` and `--open-files-in-pager=<pager>` must. */
  attached?: boolean
}

const FILTERS = ['env', 'tree', 'index', 'parent', 'msg', 'commit', 'tag-name'].map(f => `--${f}-filter`)

const OPTION_SCRIPTS: ReadonlyMap<string, ScriptOptions> = new Map(
  Object.entries({
    rebase: { long: ['--exec'], short: 'x', shortValue: 'sXCS' },
    difftool: { long: ['--extcmd'], short: 'x', shortValue: 't' },
    'filter-branch': { long: ['--setup', ...FILTERS] },
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

function optionSpans(words: readonly string[], at: number, opts: ScriptOptions): ScriptSpan[] {
  const spans: ScriptSpan[] = []
  for (let i = at + 1; i < words.length && words[i] !== '--'; i++) {
    const word = words[i] as string
    if (word.startsWith('--')) spans.push(...longSpan(word, i, words, opts))
    else if (word.startsWith('-')) spans.push(...shortSpan(word, i, words, opts))
  }
  return spans
}

/** The command after `foreach` or `run`, past the options git reads before it. */
function trailingSpan(words: readonly string[], verbAt: number): ScriptSpan[] {
  let i = verbAt + 1
  while (i < words.length && (words[i] as string).startsWith('-')) i++
  return i < words.length ? [{ from: i, to: words.length, offset: 0 }] : []
}

/** `git submodule [--quiet] [--cached] foreach [--recursive] <command>`. */
function submoduleSpans(words: readonly string[], at: number): ScriptSpan[] {
  let i = at + 1
  while (i < words.length && (words[i] as string).startsWith('-')) i++
  return words[i] === 'foreach' ? trailingSpan(words, i) : []
}

/** The script spans of `git <words>`, whose subcommand is at index `at`. */
export function gitScripts(words: readonly string[], at: number): ScriptSpan[] {
  const sub = words[at]
  if (sub === 'submodule') return submoduleSpans(words, at)
  if (sub === 'bisect') return words[at + 1] === 'run' ? trailingSpan(words, at + 1) : []
  const opts = sub === undefined ? undefined : OPTION_SCRIPTS.get(sub)
  return opts === undefined ? [] : optionSpans(words, at, opts)
}
