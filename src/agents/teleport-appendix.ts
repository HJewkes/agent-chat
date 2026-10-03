import path from 'node:path'
import type { EventStore } from '../broker/event-store.js'
import type { AgentIdentity, QueueItem } from '../protocol.js'
import { frontmatterField } from './active-work.js'
import type { AgentLog } from './identity.js'
import { isSeatName } from './seats/charter.js'
import { defaultAutonomyRoot, readText } from './seats/io.js'

/**
 * CC-524: what the broker knows that a self-written handoff routinely leaves out.
 *
 * A handoff is the predecessor's own account, and nothing checks it against the
 * agents it left running or the messages it never read. The broker has both in
 * the event log, so it appends them to the successor's first turn under a
 * heading that says who wrote them. The stored `agent_handoff` row stays verbatim.
 */

/** Past this many the list is cut; `agent_list` has the rest. */
const MAX_LISTED = 20
const QUESTION_TEXT = 120

/** States in which an agent still has a process, or is about to. */
const RUNNING: ReadonlySet<AgentIdentity['state']> = new Set(['spawning', 'live', 'detached'])

export interface AppendixFacts {
  name: string
  /** Agents spawned under the name that have not exited, newest first. */
  running: AgentIdentity[]
  /** Agents spawned under the name that exited and were never retired. */
  exitedUnretired: number
  /** Inbox rows that arrived during the predecessor's session; nothing tracks which were read. */
  arrived: number
  questions: QueueItem[]
  queueFile?: string
}

export interface AppendixQuery {
  name: string
  /** When the predecessor's session began: the window `arrived` counts over. */
  since: number
  autonomyRoot?: string
}

/** The queue file `seats/<name>.md` declares in its frontmatter, resolved against the autonomy root. */
export function declaredQueueFile(name: string, root = defaultAutonomyRoot()): string | undefined {
  if (!isSeatName(name)) return undefined
  const seatFile = readText(path.join(root, 'seats', `${name}.md`))
  const declared = seatFile === undefined ? undefined : frontmatterField(seatFile, 'queue')
  return declared === undefined || declared === '' ? undefined : path.resolve(root, declared)
}

/** Every agent spawned under `name`, without the name's own earlier generations. */
const spawnedBy = (agents: AgentLog, name: string): AgentIdentity[] =>
  agents.roster().filter(a => a.spawnedBy === name && a.name !== name && a.origin === 'spawned')

export function appendixFacts(agents: AgentLog, events: EventStore, query: AppendixQuery): AppendixFacts {
  const { name } = query
  const spawned = spawnedBy(agents, name)
  const queueFile = declaredQueueFile(name, query.autonomyRoot)
  return {
    name,
    running: spawned.filter(a => RUNNING.has(a.state)),
    exitedUnretired: spawned.filter(a => a.state === 'exited').length,
    arrived: events.inboxCountSince(name, query.since),
    questions: events.openQuestions(name),
    ...(queueFile === undefined ? {} : { queueFile }),
  }
}

function agentLines({ name, running, exitedUnretired }: AppendixFacts): string[] {
  const exited =
    exitedUnretired === 0
      ? []
      : [`${exitedUnretired} more exited and are not retired; agent_list shows them.`]
  if (running.length === 0) return [`Agents spawned by ${name} that are still running: none.`, ...exited]
  const listed = running.slice(0, MAX_LISTED).map(a => `- ${a.name} (profile ${a.profile}, ${a.state})`)
  const cut = running.length > MAX_LISTED ? [`- and ${running.length - MAX_LISTED} more`] : []
  return [
    `Agents spawned by ${name} that are still running (${running.length}):`,
    ...listed,
    ...cut,
    ...exited,
  ]
}

const inboxLine = ({ name, arrived }: AppendixFacts): string =>
  arrived === 0
    ? `Inbox: no message arrived for ${name} during your predecessor's session.`
    : `Inbox: ${arrived} message(s) arrived for ${name} during your predecessor's session. Nothing ` +
      'records which it read; chat_inbox returns them.'

function questionLines({ questions }: AppendixFacts): string[] {
  if (questions.length === 0) return ['Open chat_ask questions: none.']
  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, QUESTION_TEXT)
  return [
    `Open chat_ask questions (${questions.length}); the answers come to you:`,
    ...questions.map(q => `- ${q.msgId}: ${oneLine(q.text)}`),
  ]
}

/** The section appended to a teleport successor's first turn. */
export function renderAppendix(facts: AppendixFacts): string {
  return [
    '---',
    '## Broker appendix',
    'Your predecessor did not write this section. The broker read it from the event log when it ' +
      'started you, so check the handoff above against it.',
    [
      ...agentLines(facts),
      inboxLine(facts),
      ...questionLines(facts),
      ...(facts.queueFile === undefined ? [] : [`Queue file: ${facts.queueFile}`]),
    ].join('\n'),
  ].join('\n\n')
}
