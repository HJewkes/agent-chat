import { z } from 'zod'
import { EVENT_KINDS, type ServerMessage } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'
import { runPort } from '../port.js'

type QueueResult = Extract<ServerMessage, { t: 'queue_result' }>

export const QueuePortItem = z.object({
  msgId: z.string(),
  kind: z.enum(EVENT_KINDS),
  from: z.string(),
  text: z.string(),
  at: z.number(),
  meta: z.record(z.string(), z.string()),
})

/** `data` of a `port queue` envelope: the tick's `queue` port, every open human-queue item. */
export const QueuePortOutput = z.object({ items: z.array(QueuePortItem) })
export type QueuePortOutput = z.infer<typeof QueuePortOutput>

export const portQueueVerb = defineVerb({
  name: 'port.queue',
  description: 'print the human queue as one JSON envelope line; never starts a broker',
  args: z.object({}).strict(),
  result: Report,
  run: (_args, ctx) =>
    runPort(ctx, async (broker): Promise<QueuePortOutput> => {
      const { items } = (await broker.request({ t: 'queue' }, 'queue_result')) as QueueResult
      return { items }
    }),
})
