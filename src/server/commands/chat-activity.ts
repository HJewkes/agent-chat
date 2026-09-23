import { z } from 'zod'
import { clampLimit, positiveLimit, requiredString } from '../../args.js'
import type { QueueItem, ServerMessage, SessionInfo } from '../../protocol.js'
import { defineTool } from '../command.js'
import { ago } from '../format.js'

/** Same reasoning as chat_inbox's cap, applied to a bus-activity replay. */
const ACTIVITY_MAX = 50

function formatActivity(name: string, session: SessionInfo | undefined, events: QueueItem[]): string {
  const header = session
    ? `${name} [${session.status}, idle ${ago(session.idleMs)}] — ${session.workingOn || 'no description'}\n  ${session.cwd}`
    : `${name} is not currently registered. Last known activity below.`
  if (events.length === 0) return `${header}\n\nNothing on the bus yet.`

  const rows = events.map(e => {
    // Direction is the useful thing at a glance: what it did vs what landed on it.
    const arrow = e.from === name ? `-> ${e.meta.target ?? '?'}` : `<- ${e.from}`
    const body = e.text.replace(/\s+/g, ' ').slice(0, 90)
    return `  ${ago(Date.now() - e.at).padStart(4)} ago  ${e.kind.padEnd(16)} ${arrow.padEnd(14)} ${body}`
  })
  return `${header}\n\nRecent bus activity (this read did not notify ${name}):\n${rows.join('\n')}`
}

export const chatActivity = defineTool({
  name: 'chat_activity',
  description:
    'See what another session has been doing without interrupting it. This is a read: it puts ' +
    'nothing into that session and costs it nothing, so prefer it over messaging a peer to ask ' +
    'what it is up to. Shows bus activity — messages, status changes, permission prompts — not ' +
    'the work itself, and it still answers for a session that has already exited.',
  args: z.object({
    name: requiredString('name').describe('Registered name of the session to look at'),
    limit: positiveLimit('limit').describe('How many recent events to show (default 15)').optional(),
  }),
  result: z.string(),
  async run({ name, limit }, ctx) {
    const res = (await ctx.broker.request(
      { t: 'activity', name, limit: clampLimit(limit, 15, ACTIVITY_MAX) },
      'activity_result',
    )) as Extract<ServerMessage, { t: 'activity_result' }>
    if (!res.session && res.events.length === 0) {
      return `No session named "${name}" is registered, and nothing in the log mentions it.`
    }
    return formatActivity(name, res.session, res.events)
  },
})
