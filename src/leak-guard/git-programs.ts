import { configWords, keyOf, unreadable, type ConfigWord } from './git-unresolved.js'
import { LIVE, unmark } from './shell-words.js'

/**
 * Config keys whose value git runs as a program or shell command (TP-636). A `-c` value for one
 * is a nested script: git runs it, and passes its own `-c` options on to any git it starts.
 */

// `section.name`, or `section.*.name` for a key under a subsection; `pager.*` is matched apart.
const PROGRAM_KEYS = new Set(
  `core.pager core.editor core.sshcommand core.fsmonitor core.askpass core.gitproxy sequence.editor
  diff.external diff.*.command diff.*.textconv merge.*.driver filter.*.clean filter.*.smudge
  filter.*.process credential.helper credential.*.helper gpg.program gpg.*.program
  interactive.difffilter web.browser browser.*.cmd difftool.*.cmd mergetool.*.cmd man.*.cmd
  remote.*.receivepack remote.*.uploadpack sendemail.tocmd sendemail.cccmd sendemail.headercmd
  sendemail.sendmailcmd sendemail.smtpserver`.split(/\s+/),
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
  // A leading `!` marks a credential helper's shell snippet, and is shell negation elsewhere.
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
