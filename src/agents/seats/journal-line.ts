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

export const journalText = (entry: JournalEntry, prefix: string): string =>
  [entry.event, entry.task ?? taskOf(entry.agent, prefix) ?? ABSENT, entry.agent, entry.pr ?? ABSENT].join(
    ' ',
  )

const JOURNAL_TEXT = new RegExp(`^(${JOURNAL_EVENTS.join('|')}) \\S+ \\S+ \\S+$`)

/** Whether a log line's text has the broker's shape, so the watchdog does not read it as the seat's own. */
export const isJournalText = (text: string): boolean => JOURNAL_TEXT.test(text)

const namesEvent = (line: string, event: JournalEvent): boolean =>
  line
    .toLowerCase()
    .split(/[^a-z]+/)
    .some(word => word.startsWith(event))

const namesAgent = (line: string, agent: string): boolean => line.split(/[^\w-]+/).includes(agent)

/** Whether `log` already holds a line at `clock` for the entry's event and agent, in any wording. */
export function alreadyJournaled(log: string, clock: string, entry: JournalEntry): boolean {
  return log
    .split('\n')
    .some(
      line => line.startsWith(`${clock} `) && namesEvent(line, entry.event) && namesAgent(line, entry.agent),
    )
}
