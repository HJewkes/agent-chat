import { quoted } from './git-alias.js'
import { configWords, expandsToWords, keyOf, unreadable, type ConfigWord } from './git-unresolved.js'
import { LIVE, unmark } from './shell-words.js'
import {
  isOption,
  isSet,
  optionSpec,
  parseOptions,
  type OptionSpec,
  type OptionsEnd,
  type ParsedArgs,
  type SubArgs,
} from './git-parse-options.js'

/**
 * Config keys git never runs as a program or shell command (TP-636). The guard fails closed: every
 * other `-c` or `--config-env` key is treated as one whose value git may run, so a key git learns
 * to run, or one the guard never listed, such as `tar.<format>.command`, is still checked. A
 * section is listed whole only when none of its keys runs anything, by `git help config` on git
 * 2.53; `include.path` and `core.hooksPath` are read by their own checks.
 */
const INERT_SECTIONS = new Set(
  `user author committer color column advice i18n log status format commit tag branch push fetch http
  pack index feature transfer safe fsck blame grep checkout notes pretty reset stash
  versionsort am apply`.split(/\s+/),
)

// `section.name`, or `section.*.name` for a key under a subsection.
const INERT_KEYS = new Set(
  `include.path includeif.*.path core.hookspath core.quotepath core.autocrlf core.eol core.safecrlf
  core.filemode core.ignorecase core.symlinks core.bare core.abbrev core.excludesfile
  core.attributesfile core.whitespace core.compression core.precomposeunicode core.commentchar
  core.commentstring core.untrackedcache core.preloadindex core.logallrefupdates core.longpaths
  diff.noprefix diff.mnemonicprefix diff.renames diff.renamelimit diff.algorithm diff.colormoved
  diff.context diff.submodule merge.ff merge.conflictstyle merge.log merge.renamelimit
  merge.autostash rebase.autosquash rebase.autostash rebase.updaterefs pull.rebase pull.ff
  protocol.version help.autocorrect help.format init.defaultbranch clone.defaultremotename gc.auto gc.autodetach
  submodule.recurse submodule.*.url submodule.*.path submodule.*.branch submodule.*.active
  remote.*.url remote.*.pushurl remote.*.fetch remote.*.push remote.*.mirror remote.*.tagopt
  remote.*.prune remote.*.skipdefaultupdate url.*.insteadof url.*.pushinsteadof
  credential.usehttppath credential.username credential.*.usehttppath credential.*.username`.split(/\s+/),
)

/** A key's lower-cased section, its subsection as written, and its lower-cased name; null without a dot. */
function splitKey(key: string): { section: string; sub: string | undefined; name: string } | null {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first < 0) return null
  const sub = first === last ? undefined : key.slice(first + 1, last)
  return { section: key.slice(0, first).toLowerCase(), sub, name: key.slice(last + 1).toLowerCase() }
}

/** Whether git may run the value of `key` as a program: every key but the inert ones. */
export function runsProgram(key: string): boolean {
  const parts = splitKey(key)
  if (parts === null) return true
  if (INERT_SECTIONS.has(parts.section)) return false
  return !INERT_KEYS.has(`${parts.section}.${parts.sub === undefined ? '' : '*.'}${parts.name}`)
}

/**
 * Environment variables whose value git, or the man and less it starts, runs as a program or
 * shell command, including the `PAGER`, `EDITOR` and `VISUAL` fallbacks git honours, the
 * askpass and proxy hooks, man's `MANPAGER` and the `BROWSER` git web--browse may read.
 */
export const PROGRAM_ENV = new Set([
  'GIT_PAGER',
  'PAGER',
  'MANPAGER',
  'GIT_EDITOR',
  'EDITOR',
  'VISUAL',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND',
  'BROWSER',
])

/**
 * Environment variables whose value is not a command line but may still make man or less run
 * one: less options (`+!cmd`), a less input preprocessor (`|cmd %s`) and man options (`-P cmd`).
 * The guard cannot check such a value as a script, so any assignment to one denies.
 */
export const OPAQUE_PROGRAM_ENV = new Set(['LESS', 'LESSOPEN', 'LESSCLOSE', 'MANOPT'])

/**
 * The protocol list git honours over `protocol.*.allow` (TP-2371): listing `ext` lets an `ext::`
 * URL run a shell command, and unsetting it lifts a list agent-chat pins.
 */
export const PROTOCOL_ENV = new Set(['GIT_ALLOW_PROTOCOL'])

/** Whether a colon-separated protocol list names `ext`, as git reads it: any case, blanks trimmed. */
export const listsExt = (value: string): boolean =>
  value.split(':').some(protocol => protocol.trim().toLowerCase() === 'ext')

/** The script one config word runs: null for none, undefined when the guard cannot read it. */
function scriptOf(word: ConfigWord): string | null | undefined {
  const pair = keyValue(word)
  if (pair === undefined) return undefined
  if (!runsProgram(pair.key) || pair.value === null) return null
  // A leading `!` marks a shell snippet for a credential helper or submodule update, and is shell negation elsewhere.
  return pair.value?.startsWith('!') ? pair.value.slice(1) : pair.value
}

/** A config word's key and value: the value undefined when the guard cannot read it, null when the word sets none. */
function keyValue(word: ConfigWord): { key: string; value: string | null | undefined } | undefined {
  if (unreadable(word)) return undefined
  const kv = word.resolved ?? unmark(word.marked)
  const key = keyOf(kv, word.fromEnv)
  // A `--config-env` value comes from a variable, and a `-c` value the shell expands is unread.
  if (word.fromEnv || word.marked.includes(LIVE)) return { key, value: undefined }
  const eq = kv.indexOf('=')
  return { key, value: eq < 0 ? null : kv.slice(eq + 1) }
}

/** The scripts git's `-c` options run, or undefined when one may run a program the guard cannot read. */
export function configPrograms(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): string[] | undefined {
  const scripts: string[] = []
  for (const word of configWords(resolved, marked, splits)) {
    const script = scriptOf(word)
    if (script === undefined) return undefined
    if (script !== null) scripts.push(script)
  }
  return scripts
}

/**
 * The command an `ext::` transport payload runs, as `git-remote-ext` decodes it: arguments split
 * on spaces, `% ` an embedded space, `%%` a literal percent, `%s`/`%S`/`%G`/`%V` substitutions the
 * guard cannot know. The argv is shell-quoted back into one line to check. undefined when it cannot
 * be decoded, as a trailing or unknown `%` escape cannot.
 */
export function decodeExt(payload: string): string | undefined {
  const args: string[] = []
  let cur = ''
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i] as string
    if (c === '%') {
      const next = payload[++i]
      if (next === ' ') cur += ' '
      else if (next === '%') cur += '%'
      else if (next !== undefined && 'sSGV'.includes(next)) cur += ''
      else return undefined
    } else if (c === ' ') {
      args.push(cur)
      cur = ''
    } else cur += c
  }
  args.push(cur)
  return args
    .filter(a => a !== '')
    .map(quoted)
    .join(' ')
}

const EXT = 'ext::'
const URL_REWRITE = /^url\..*\.(?:push)?insteadof$/i
const hasExt = (text: string): boolean => text.toLowerCase().includes(EXT)

/**
 * The payload of the `ext::` URL that one text is, for git: git runs `ext::` only as a whole URL,
 * so the span is the text when it starts with `ext::`. null for none, undefined when `ext::` sits
 * elsewhere in the text and the span git runs cannot be pinned down.
 */
function urlPayload(text: string): string | null | undefined {
  if (text.toLowerCase().startsWith(EXT)) return text.slice(EXT.length)
  return hasExt(text) ? undefined : null
}

/**
 * The `ext::` payload one config `key=value` runs: its value as a URL. A `url.<base>.insteadOf` or
 * `.pushInsteadOf` base is joined to the rest of each URL it matches, so the end of an `ext::` base's
 * command is not pinned down.
 */
function configPayload(kv: string): string | null | undefined {
  const eq = kv.indexOf('=')
  const key = eq < 0 ? kv : kv.slice(0, eq)
  if (URL_REWRITE.test(key) && hasExt(key)) return undefined
  return eq < 0 ? null : urlPayload(kv.slice(eq + 1))
}

/** The `ext::` payload of one argument: the word, or the value of a `--name=value` option. */
function argPayload(word: string): string | null | undefined {
  const option = /^--[\w-]+=/.exec(word)?.[0]
  return urlPayload(option === undefined ? word : word.slice(option.length))
}

/** The `ext::` payload of one config word; a `--config-env` value is read from the environment, so only its key counts. */
function configWordPayload(word: ConfigWord): string | null | undefined {
  if (!hasExt(unmark(word.marked))) return null
  if (word.resolved === undefined) return undefined
  if (!word.fromEnv) return configPayload(word.resolved)
  const key = keyOf(word.resolved, true)
  return URL_REWRITE.test(key) && hasExt(key) ? undefined : null
}

// Helpers that read the URL as a URL; any other `remote.<name>.vcs` helper, such as `ext`, is handed it to run.
const URL_VCS = new Set(['http', 'https', 'ftp', 'ftps'])

/**
 * The URLs a `remote.<name>.vcs` helper is handed as its own payload, without an `ext::` prefix
 * (TP-636): `vcs=ext` runs the remote's `url` and `pushurl` as an ext command. For each remote whose
 * helper is not one of URL_VCS, its `-c` url and pushurl values; undefined when such a URL is not on
 * the line or not readable, or when `git clone` or an `insteadOf` rewrite supplies it.
 */
function vcsPayloads(config: readonly ConfigWord[], sub: string | undefined): string[] | undefined {
  const pairs = config.map(keyValue)
  const runs = new Set<string | undefined>()
  for (const pair of pairs) {
    const parts = pair && splitKey(pair.key)
    if (!parts || parts.section !== 'remote' || parts.name !== 'vcs') continue
    if (typeof pair.value !== 'string' || !URL_VCS.has(pair.value.toLowerCase())) runs.add(parts.sub)
  }
  if (runs.size === 0) return []
  if (sub === 'clone' || pairs.some(pair => pair && URL_REWRITE.test(pair.key))) return undefined
  const urls: string[] = []
  for (const remote of runs) {
    const own = pairs.filter(pair => {
      const parts = pair && splitKey(pair.key)
      return parts?.section === 'remote' && parts.sub === remote && /^(?:push)?url$/.test(parts.name)
    })
    if (own.length === 0) return undefined
    for (const pair of own) {
      if (typeof pair?.value !== 'string') return undefined
      urls.push(pair.value)
    }
  }
  return urls
}

/**
 * Whether git's config words switch on the `ext::` transport (TP-636): `protocol.allow` or
 * `protocol.ext.allow` set to anything but `never`, or to a value the guard cannot read. git may
 * then run an `ext::` URL from the repository's config, which the line does not show.
 */
function enablesExt(config: readonly ConfigWord[]): boolean {
  return config.some(word => {
    const pair = keyValue(word)
    return pair !== undefined && allowsExt(pair.key, pair.value)
  })
}

/** Whether setting `key` to `value` lets git run `ext::` URLs: `protocol.allow` or `protocol.ext.allow` other than `never`. */
function allowsExt(key: string, value: string | null | undefined): boolean {
  const parts = splitKey(key)
  if (parts?.section !== 'protocol' || parts.name !== 'allow') return false
  if (parts.sub !== undefined && parts.sub.toLowerCase() !== 'ext') return false
  return value?.toLowerCase() !== 'never'
}

// `git config`'s options, legacy and subcommand forms together, from `git config -h` on git 2.53.
const CONFIG_OPTIONS = optionSpec(
  `[no-]global [no-]system [no-]local [no-]worktree f:[no-]file= [no-]blob= get get-all get-regexp
  get-urlmatch replace-all add unset unset-all rename-section remove-section l:list e:edit get-color
  get-colorbool z:[no-]null [no-]name-only [no-]show-origin [no-]show-scope [no-]show-names
  t:[no-]type= bool int bool-or-int bool-or-str path expiry-date [no-]default= [no-]comment=
  [no-]fixed-value [no-]includes [no-]append [no-]all [no-]regexp [no-]value= [no-]url=`,
)
// `git config` modes, legacy options and subcommands alike, that read or remove rather than set a value.
const CONFIG_NON_WRITES = new Set(
  `get get-all get-regexp get-urlmatch get-color get-colorbool list unset unset-all remove-section edit help`.split(
    /\s+/,
  ),
)
const CONFIG_SUBCOMMANDS = new Set([...CONFIG_NON_WRITES, 'set', 'rename-section'])
const SUBMODULE_ADD = `q:[no-]quiet b:[no-]branch= f:[no-]force [no-]progress [no-]reference= [no-]ref-format=
  [no-]dissociate [no-]name= [no-]depth=`
// `git clone`'s options, from `git clone -h` on git 2.53. `--recurse-submodules[=<pathspec>]` takes
// its value only attached, so it reads as a flag.
const CLONE_OPTIONS = optionSpec(
  `v:[no-]verbose q:[no-]quiet [no-]progress [no-]reject-shallow n:no-checkout checkout [no-]bare
  [no-]mirror l:[no-]local no-hardlinks hardlinks s:[no-]shared [no-]recurse-submodules [no-]recursive
  j:[no-]jobs= [no-]template= [no-]reference= [no-]reference-if-able= [no-]dissociate o:[no-]origin=
  b:[no-]branch= [no-]revision= u:[no-]upload-pack= [no-]depth= [no-]shallow-since= [no-]shallow-exclude=
  [no-]single-branch [no-]tags [no-]shallow-submodules [no-]separate-git-dir= [no-]ref-format=
  c:[no-]config= [no-]server-option= 4:ipv4 6:ipv6 [no-]filter= [no-]also-filter-submodules
  [no-]remote-submodules [no-]sparse [no-]bundle-uri=`,
)

/**
 * How a builtin that stores a remote or submodule URL reads its words, from its `-h` lists on git
 * 2.53 (TP-2371). `lead` holds the options before the verb; `writes` the verbs that store a URL,
 * each with its options and, for `remote set-url --delete`, the option state that stores none;
 * `safe` the verbs that store none. A verb in neither is treated as one that may store any word it
 * is given. `git clone` has no verb and stores only its repository, as `remote.origin.url`, so
 * `cloneUrlEnabler` reads it instead (TP-2444).
 */
interface UrlCommand {
  lead: OptionSpec
  writes: Readonly<Record<string, { options: OptionSpec; storesNone?: (parsed: ParsedArgs) => boolean }>>
  safe: ReadonlySet<string>
}

const URL_COMMANDS: Readonly<Record<string, UrlCommand>> = {
  remote: {
    lead: optionSpec('v:[no-]verbose'),
    writes: {
      add: { options: optionSpec('f:[no-]fetch [no-]tags t:[no-]track= m:[no-]master= [no-]mirror') },
      'set-url': {
        options: optionSpec('[no-]push [no-]add [no-]delete'),
        storesNone: parsed => isSet(parsed, 'delete') && !isSet(parsed, 'add'),
      },
    },
    safe: new Set('rename remove rm show prune update get-url set-head set-branches'.split(' ')),
  },
  submodule: {
    lead: optionSpec('q:[no-]quiet [no-]cached'),
    writes: {
      add: { options: optionSpec(SUBMODULE_ADD) },
      'set-url': { options: optionSpec('q:[no-]quiet') },
    },
    safe: new Set('init deinit update status summary foreach sync absorbgitdirs set-branch'.split(' ')),
  },
  'submodule--helper': {
    lead: optionSpec(''),
    writes: {
      add: { options: optionSpec(SUBMODULE_ADD) },
      'set-url': { options: optionSpec('q:[no-]quiet') },
    },
    safe: new Set(),
  },
}

// Keys whose value git reads as a remote's or submodule's URL or URL helper; `url.<base>.insteadOf` also takes one in its key.
const URL_KEY = /^(?:(?:remote|submodule)\..*\.(?:url|pushurl|vcs)|url\..*\.(?:push)?insteadof)$/i
// Sections a renamed section may land in and so set a protocol policy or a URL git later runs.
const URL_SECTION = /^(?:remote|url|submodule)(?:[."\s]|$)/i
const PROTOCOL_SECTION = /^protocol(?:[."\s]|$)/i

/** What a write enables for `ext::`; `option` when the guard cannot tell which word is the key, URL or verb. */
export type ExtEnabler = 'protocol' | 'url' | 'option'

/** What a `git config` call does with its words: sets a key, renames a section, or neither. */
interface ConfigCall {
  mode: 'set' | 'rename' | 'other'
  positionals: (string | undefined)[]
}

function configCall(parsed: ParsedArgs, named: string | undefined): ConfigCall {
  const { positionals } = parsed
  const reads = [...CONFIG_NON_WRITES].some(mode => isSet(parsed, mode))
  if (reads || (named !== undefined && CONFIG_NON_WRITES.has(named))) return { mode: 'other', positionals }
  const rename = isSet(parsed, 'rename-section') || named === 'rename-section'
  return { mode: rename ? 'rename' : 'set', positionals }
}

// git 2.53 names a `git config` subcommand only as its first word; `--file f set k v` is legacy.
// The subcommand form stops at `--`. Legacy reads past a leading `--`; past one after an option git
// stops, so reading on there only over-denies.
const SUBCOMMAND_END: OptionsEnd = { atDashDash: true, atPositional: false }
const LEGACY_END: OptionsEnd = { atDashDash: false, atPositional: true }

/** A `git config` call's subcommand, if its first word names one, and its options and positionals. */
function parseConfig(args: SubArgs): { named: string | undefined; parsed: ParsedArgs | undefined } {
  const first = args.resolved[0]
  if (first === undefined || !CONFIG_SUBCOMMANDS.has(first))
    return { named: undefined, parsed: parseOptions(args, CONFIG_OPTIONS, LEGACY_END) }
  const rest = { resolved: args.resolved.slice(1), written: args.written.slice(1) }
  return { named: first, parsed: parseOptions(rest, CONFIG_OPTIONS, SUBCOMMAND_END) }
}

/**
 * A section rename that may land a protocol policy or a URL where git reads one: `protocol` for a
 * target under `protocol`, `url` for one under `remote`, `url` or `submodule`, or a name the guard cannot read.
 */
function renameEnabler(names: readonly (string | undefined)[]): ExtEnabler | undefined {
  const target = names[1]
  if (names.includes(undefined) || target === undefined) return 'url'
  if (PROTOCOL_SECTION.test(target)) return 'protocol'
  return URL_SECTION.test(target) ? 'url' : undefined
}

function configEnabler(args: SubArgs): ExtEnabler | undefined {
  const { named, parsed } = parseConfig(args)
  if (parsed === undefined) return 'option'
  const { mode, positionals } = configCall(parsed, named)
  if (mode === 'rename') return renameEnabler(positionals)
  if (mode === 'other' || positionals.length < 2) return undefined
  const [key, value] = positionals
  if (key === undefined) return 'url'
  if (allowsExt(key, value)) return 'protocol'
  return URL_KEY.test(key) && value === undefined ? 'url' : undefined
}

const tail = (args: SubArgs, from: number): SubArgs => ({
  resolved: args.resolved.slice(from),
  written: args.written.slice(from),
})

/**
 * Whether a URL-storing builtin may store a URL the guard cannot read: `url` for any word it cannot
 * read after a verb that stores one or after a verb outside the table, unless the options leave a
 * state the table says stores none; `option` for an option it
 * cannot match. A verb in `safe`, and a call with no verb, store none.
 */
function urlEnabler(args: SubArgs, command: UrlCommand): ExtEnabler | undefined {
  const at = args.resolved.findIndex((_, i) => !isOption(args, i))
  const lead = at < 0 ? args : { resolved: args.resolved.slice(0, at), written: args.written.slice(0, at) }
  const leading = parseOptions(lead, command.lead)
  if (leading === undefined) return 'option'
  if (at < 0 || isSet(leading, 'help')) return undefined
  const verb = args.resolved[at]
  if (verb !== undefined && command.safe.has(verb)) return undefined
  const rest = tail(args, at + 1)
  const write = verb === undefined ? undefined : command.writes[verb]
  if (write === undefined) return args.resolved.slice(at).includes(undefined) ? 'url' : undefined
  const parsed = parseOptions(rest, write.options)
  if (parsed === undefined) return 'option'
  if (isSet(parsed, 'help') || write.storesNone?.(parsed)) return undefined
  return rest.resolved.includes(undefined) ? 'url' : undefined
}

/**
 * Whether `git clone` stores a repository URL the guard cannot read as `remote.origin.url` (TP-2444):
 * `url` when its first positional is unread. Past an option the guard cannot match it is `url` for
 * any unread word and otherwise none, so an unknown literal flag stays allowed. An unread directory
 * and `-h` store none.
 */
function cloneUrlEnabler(args: SubArgs): ExtEnabler | undefined {
  const parsed = parseOptions(args, CLONE_OPTIONS)
  if (parsed === undefined) return args.resolved.includes(undefined) ? 'url' : undefined
  if (isSet(parsed, 'help') || parsed.positionals.length === 0) return undefined
  return parsed.positionals[0] === undefined ? 'url' : undefined
}

/**
 * What a `git config` write, or a write by a builtin in URL_COMMANDS, at `at` would enable for `ext::`
 * (TP-2371): `protocol` when it sets `protocol.allow` or `protocol.ext.allow` to anything but
 * `never`, or renames a section into `protocol`; `url` when it writes a remote or submodule URL,
 * URL helper or `insteadOf` rewrite, a key or verb, the guard cannot read, or renames a section into
 * one of those, so it may hide an `ext::` URL a later git runs; `option` when an option is one git
 * would read but the guard cannot match to exactly one it knows. undefined for none.
 * The words are read one shell word to one argument, so for these builtins a word after the
 * subcommand that may expand to none or several (an unquoted expansion, `"$@"`, `"${A[@]}"`, a
 * glob or a brace) leaves the argument list unknown, which is `url`. `git clone` is read by
 * `cloneUrlEnabler`; its splitting words are already `gitConfigUnresolved`.
 */
export function extEnablerWrite(run: GitWords, at: number): ExtEnabler | undefined {
  const sub = run.resolved[at]
  if (sub === 'clone') return cloneUrlEnabler(tail(run, at + 1))
  const command = sub === undefined ? undefined : URL_COMMANDS[sub]
  if (sub !== 'config' && command === undefined) return undefined
  if (run.marked.slice(at + 1).some(word => expandsToWords(word, run.splits))) return 'url'
  const args = { resolved: run.resolved.slice(at + 1), written: run.written.slice(at + 1) }
  return command === undefined ? configEnabler(args) : urlEnabler(args, command)
}

/** A git command's words: as the shell passes them, as written, and marked, with those the shell splits. */
export interface GitWords {
  resolved: readonly (string | undefined)[]
  written: readonly string[]
  marked: readonly string[]
  splits: readonly string[]
}

/**
 * The commands `ext::` transport URLs run on a git command (TP-636): the span of each argument or
 * config value (every word `configWords` lists) git runs as an `ext::` URL, the URLs a `remote.<name>.vcs`
 * helper runs, and the command of `git remote-ext <name> <cmd>`.
 * `unreadable` when a word holding `ext::` has an expansion the guard cannot read, a span it cannot
 * pin down, or a payload it cannot decode; `enabled` when the config switches the transport on.
 */
export function extPrograms(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
  at: number,
): { scripts: string[]; unreadable: boolean; enabled: boolean } {
  const scripts: string[] = []
  let unreadable = false
  const decode = (payload: string | null | undefined): void => {
    if (payload === null) return
    const script = payload === undefined ? undefined : decodeExt(payload)
    if (script === undefined) unreadable = true
    else scripts.push(script)
  }
  const config = configWords(resolved, marked, splits)
  config.forEach(word => decode(configWordPayload(word)))
  const vcs = vcsPayloads(config, resolved[at])
  if (vcs === undefined) unreadable = true
  else vcs.forEach(decode)
  const held = new Set(config.map(word => word.index))
  marked.forEach((word, i) => {
    if (held.has(i) || !hasExt(unmark(word))) return
    const value = resolved[i]
    decode(value === undefined ? undefined : argPayload(value))
  })
  if (resolved[at] === 'remote-ext') {
    const cmd = resolved[at + 2]
    if (cmd === undefined && marked[at + 2] !== undefined) unreadable = true
    else if (cmd !== undefined) decode(cmd)
  }
  return { scripts, unreadable, enabled: enablesExt(config) }
}
