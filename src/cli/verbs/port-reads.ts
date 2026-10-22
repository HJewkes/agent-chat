import { z } from 'zod'
import { EXIT } from '@titan-design/registry'
import { AGENT_LIFECYCLES, WAKE_SOURCES, type ServerMessage } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'
import { runPort } from '../port.js'
import { collisionView, INBOX_PAGE, tickRoster } from '../port-reads.js'

type InboxSinceResult = Extract<ServerMessage, { t: 'inbox_since_result' }>
type MessageByIdResult = Extract<ServerMessage, { t: 'message_by_id_result' }>

/** Loose: the tick reads these fields, and the rest of a row passes through for whoever needs it. */
export const RosterPortAgent = z.looseObject({
  agentId: z.string(),
  name: z.string(),
  state: z.enum(AGENT_LIFECYCLES),
  spawnedAt: z.number(),
  exitedAt: z.number().optional(),
})

/** `data` of a `port roster` envelope: the tick's `roster` port, retired rows included. */
export const RosterPortOutput = z.object({
  agents: z.array(RosterPortAgent),
  slots: z.object({ held: z.number(), cap: z.number() }).optional(),
  partial: z.string().optional(),
})
export type RosterPortOutput = z.infer<typeof RosterPortOutput>

/** `data` of a `port files-claims` envelope: the tick's `collisionView` port. */
export const FilesClaimsPortOutput = z.object({
  names: z.array(z.string()),
  claims: z.array(z.object({ owner: z.string(), repo: z.string(), patterns: z.array(z.string()) })),
  recentlyExited: z.array(z.string()).optional(),
})
export type FilesClaimsPortOutput = z.infer<typeof FilesClaimsPortOutput>

export const InboxSincePortMessage = z.looseObject({
  id: z.number(),
  msgId: z.string(),
  from: z.string(),
  text: z.string(),
})

/** `data` of a `port inbox-since` envelope: messages after the cursor, and the cursor to pass next. */
export const InboxSincePortOutput = z.object({
  messages: z.array(InboxSincePortMessage),
  nextCursor: z.number(),
})
export type InboxSincePortOutput = z.infer<typeof InboxSincePortOutput>

/** `data` of a `port message` envelope: one stored message row (CC-1557). */
export const MessagePortOutput = z.object({
  msgId: z.string(),
  kind: z.string(),
  from: z.string(),
  target: z.string(),
  text: z.string(),
  at: z.number(),
  wakeSource: z.enum(WAKE_SOURCES).optional(),
  provenance: z.enum(['human-endorsed', 'decided']).optional(),
})
export type MessagePortOutput = z.infer<typeof MessagePortOutput>

const NO_ARGS = z.object({}).strict()

export const portRosterVerb = defineVerb({
  name: 'port.roster',
  description: 'print every agent row, retired ones included, and the slot count as one JSON line',
  args: NO_ARGS,
  result: Report,
  run: (_args, ctx) => runPort(ctx, broker => tickRoster(broker)),
})

export const portFilesClaimsVerb = defineVerb({
  name: 'port.files-claims',
  description: 'print live names, recently exited agents and every files claim as one JSON line',
  args: NO_ARGS,
  result: Report,
  run: (_args, ctx) => runPort(ctx, broker => collisionView(broker)),
})

export const portInboxSinceVerb = defineVerb({
  name: 'port.inbox-since',
  description: "print a session's messages after a cursor as one JSON line; delivers nothing",
  args: z.object({
    name: z.string().min(1),
    afterId: z.coerce.number().int().nonnegative(),
    limit: z.coerce.number().int().positive().optional(),
  }),
  result: Report,
  cli: {
    positional: ['name', 'afterId'],
    options: { limit: { long: '--limit', description: `most messages to return (default ${INBOX_PAGE})` } },
  },
  run: ({ name, afterId, limit }, ctx) =>
    runPort(ctx, async broker => {
      const frame = { t: 'inbox_since' as const, name, afterId, limit: limit ?? INBOX_PAGE }
      const { messages, nextCursor } = (await broker.request(frame, 'inbox_since_result')) as InboxSinceResult
      return { messages, nextCursor }
    }),
})

export const portMessageVerb = defineVerb({
  name: 'port.message',
  description: 'print one message by its msg id as one JSON line; an unknown id prints nothing and exits 66',
  args: z.object({ msgId: z.string().min(1) }),
  result: Report,
  cli: { positional: ['msgId'] },
  run: async ({ msgId }, ctx) => {
    let found = true
    const report = await runPort(ctx, async broker => {
      const frame = { t: 'message_by_id' as const, msgId }
      const { message } = (await broker.request(frame, 'message_by_id_result')) as MessageByIdResult
      found = message !== undefined
      return message
    })
    if (found) return report
    // A caller gates on the id being real, so an unknown one leaves stdout empty rather than printing an envelope.
    return { ok: false, lines: [], errors: [`no message has id ${msgId}`], exit: EXIT.NOINPUT }
  },
})
