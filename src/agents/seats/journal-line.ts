/** CC-316: the shape of a seat journal line the broker writes, `<event> <task> <agent> <pr@head>`. Pure. */

export const JOURNAL_EVENTS = ['spawn', 'retire', 'park', 'merged', 'stalled'] as const
export type JournalEvent = (typeof JOURNAL_EVENTS)[number]

export interface JournalEntry {
  event: JournalEvent
  agent: string
  /** Given when the caller holds the task id; otherwise it is read from the agent name. */
  task?: string
  /** `owner/repo#n@<short sha>`, from `prRef`. */
  pr?: string
}

const ABSENT = '-'
const SHORT_SHA = 7

/** The task id leading an agent name after its seat prefix: `sx-ab-12-fix` names `AB-12`. */
export function taskOf(agent: string, prefix: string): string | undefined {
  const m = /^([a-z][a-z0-9]*)-(\d+)(?:-|$)/i.exec(agent.slice(prefix.length + 1))
  return m === null ? undefined : `${m[1]?.toUpperCase()}-${m[2]}`
}

/** A pull request URL and its head as `owner/repo#n@<short sha>`; undefined unless both are known. */
export function prRef(url: string | undefined, head: string | undefined): string | undefined {
  const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url ?? '')
  if (m === null || head === undefined || head === '') return undefined
  return `${m[1]}#${m[2]}@${head.slice(0, SHORT_SHA)}`
}

const TASK = String.raw`(?:-|[A-Za-z][A-Za-z0-9]*-\d+)`
/** A seat's agent is `<prefix>-<rest>`, which also keeps a bare word of prose from reading as one. */
const AGENT = String.raw`[A-Za-z0-9]+-[A-Za-z0-9][A-Za-z0-9._-]*`
const PR = String.raw`-|[\w.-]+/[\w.-]+#\d+@[0-9a-f]{7}`
const JOURNAL_TEXT = new RegExp(`^(${JOURNAL_EVENTS.join('|')}) ${TASK} (${AGENT}) (${PR})$`)
const CLOCKED = /^\d\d:\d\d (.*)$/

/** The events the broker itself sees, which never carry a PR. */
const LIFECYCLE: readonly string[] = ['spawn', 'retire', 'park']

/** The agent a broker line names; undefined for any other text, so the seat's own prose never reads as the broker's. */
function agentOf(text: string): string | undefined {
  const m = JOURNAL_TEXT.exec(text)
  if (m === null || (LIFECYCLE.includes(m[1] ?? '') && m[3] !== ABSENT)) return undefined
  return m[2]
}

/** Whether a log line's text is exactly the broker's shape, so the watchdog does not read it as the seat's own. */
export const isJournalText = (text: string): boolean => agentOf(text) !== undefined

/** Undefined when a field is not one plain token: a line the watchdog could not tell from the seat's is never written. */
export function journalText(entry: JournalEntry, prefix: string): string | undefined {
  const task = entry.task ?? taskOf(entry.agent, prefix) ?? ABSENT
  const text = [entry.event, task, entry.agent, entry.pr ?? ABSENT].join(' ')
  return isJournalText(text) ? text : undefined
}

/** Whether the latest broker line for its agent in `log` is `line`, clock included; a respawn after a retire is a new line. */
export function alreadyJournaled(log: string, line: string): boolean {
  const agent = agentOf(CLOCKED.exec(line)?.[1] ?? '')
  const latest = log.split('\n').findLast(l => agentOf(CLOCKED.exec(l)?.[1] ?? '') === agent)
  return latest === line
}
