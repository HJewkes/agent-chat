import { quoted } from './git-alias.js'
import { configWords, keyOf, unreadable, type ConfigWord } from './git-unresolved.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * Config keys git never runs as a program or shell command (TP-636). The guard fails closed: every
 * other `-c` or `--config-env` key is treated as one whose value git may run, so a key git learns
 * to run, or one the guard never listed, such as `tar.<format>.command`, is still checked. A
 * section is listed whole only when none of its keys runs anything, by `git help config` on git
 * 2.53; `include.path` and `core.hooksPath` are read by their own checks.
 */
const INERT_SECTIONS = new Set(
  `user author committer color column advice i18n log status format commit tag branch push fetch
  protocol http pack index feature transfer safe fsck blame grep checkout notes pretty reset stash
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
  help.autocorrect help.format init.defaultbranch clone.defaultremotename gc.auto gc.autodetach
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
 * The commands `ext::` transport URLs run on a git command (TP-636): the span of each argument or
 * config value (every word `configWords` lists) git runs as an `ext::` URL, the URLs a `remote.<name>.vcs`
 * helper runs, and the command of `git remote-ext <name> <cmd>`.
 * `unreadable` when a word holding `ext::` has an expansion the guard cannot read, a span it cannot
 * pin down, or a payload it cannot decode.
 */
export function extPrograms(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
  at: number,
): { scripts: string[]; unreadable: boolean } {
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
  return { scripts, unreadable }
}
