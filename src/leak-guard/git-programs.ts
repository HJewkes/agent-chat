import { quoted } from './git-alias.js'
import { configWords, keyOf, unreadable, type ConfigWord } from './git-unresolved.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * Config keys and environment variables whose value git runs as a program or shell command
 * (TP-636). A `-c` value or an env value for one is a nested script: git runs it, and passes its
 * own `-c` options on to any git it starts. The keys and names are from `git help config` and the
 * ENVIRONMENT section of `git help git` on git 2.53.
 */

// `section.name`, or `section.*.name` for a key under a subsection; `pager.*` is matched apart.
const PROGRAM_KEYS = new Set(
  `core.pager core.editor core.sshcommand core.fsmonitor core.askpass core.gitproxy
  core.alternaterefscommand sequence.editor diff.external diff.*.command diff.*.textconv
  merge.*.driver filter.*.clean filter.*.smudge filter.*.process credential.helper
  credential.*.helper gpg.program gpg.*.program gpg.*.defaultkeycommand interactive.difffilter
  web.browser browser.*.cmd browser.*.path difftool.*.cmd difftool.*.path mergetool.*.cmd
  mergetool.*.path man.*.cmd man.*.path guitool.*.cmd instaweb.browser instaweb.httpd
  remote.*.receivepack remote.*.uploadpack submodule.*.update sendemail.tocmd sendemail.*.tocmd
  sendemail.cccmd sendemail.*.cccmd sendemail.headercmd sendemail.*.headercmd
  sendemail.sendmailcmd sendemail.*.sendmailcmd sendemail.smtpserver sendemail.*.smtpserver
  trailer.*.cmd trailer.*.command hook.*.command gc.recentobjectshook
  uploadpack.packobjectshook imap.tunnel`.split(/\s+/),
)

/** Whether git runs the value of `key` as a program; section and name compare case-insensitively. */
export function runsProgram(key: string): boolean {
  const parts = key.split('.')
  if (parts.length < 2) return false
  const section = (parts[0] as string).toLowerCase()
  const name = (parts[parts.length - 1] as string).toLowerCase()
  if (section === 'pager') return true
  return PROGRAM_KEYS.has(parts.length > 2 ? `${section}.*.${name}` : `${section}.${name}`)
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
  if (unreadable(word)) return undefined
  const kv = word.resolved ?? unmark(word.marked)
  const key = keyOf(kv, word.fromEnv)
  if (!runsProgram(key)) return null
  // A `--config-env` value comes from a variable, and a `-c` value the shell expands is unread.
  if (word.fromEnv || word.marked.includes(LIVE)) return undefined
  const eq = kv.indexOf('=')
  if (eq < 0) return null
  const value = kv.slice(eq + 1)
  // A leading `!` marks a shell snippet for a credential helper or submodule update, and is shell negation elsewhere.
  return value.startsWith('!') ? value.slice(1) : value
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
  if (option === '--config=') return configPayload(word.slice(option.length))
  return urlPayload(option === undefined ? word : word.slice(option.length))
}

const CONFIG_FLAGS = new Set(['-c', '--config'])

/**
 * The commands `ext::` transport URLs run on a git command (TP-636): the span of each argument or
 * config value git runs as an `ext::` URL, and the command of `git remote-ext <name> <cmd>`.
 * `unreadable` when a word holding `ext::` has an expansion the guard cannot read, a span it cannot
 * pin down, or a payload it cannot decode.
 */
export function extPrograms(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
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
  marked.forEach((word, i) => {
    if (!hasExt(unmark(word))) return
    const value = resolved[i]
    if (value === undefined) unreadable = true
    else decode(CONFIG_FLAGS.has(resolved[i - 1] ?? '') ? configPayload(value) : argPayload(value))
  })
  if (resolved[at] === 'remote-ext') {
    const cmd = resolved[at + 2]
    if (cmd === undefined && marked[at + 2] !== undefined) unreadable = true
    else if (cmd !== undefined) decode(cmd)
  }
  return { scripts, unreadable }
}
