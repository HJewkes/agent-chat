import { z } from 'zod'
import type { QueueItem, ServerMessage } from '../../protocol.js'
import { ago } from '../client.js'
import { defineVerb, Report, type VerbContext } from '../command.js'

type QueueResult = Extract<ServerMessage, { t: 'queue_result' }>

/**
 * CC-426: the decider reads the human queue here because `inbox --batch --answers`
 * dispatches approve and endorse. This path sends one `queue` frame and nothing
 * else, takes no answer input, and imports nothing from `src/inbox/`, so no flag
 * can turn it into a writer.
 */
async function readQueue(ctx: VerbContext): Promise<QueueResult> {
  return (await ctx.withBroker(b => b.request({ t: 'queue' }, 'queue_result'))) as QueueResult
}

function describeItems(items: QueueItem[]): string[] {
  if (items.length === 0) return ['Nothing waiting.']
  return items.flatMap(item => [
    `${item.kind} ${item.msgId}  ${item.from}  ${ago(item.at)}`,
    `      ${item.text}`,
  ])
}

export const queueReadVerb = defineVerb({
  name: 'human.queue',
  description: 'read the human queue; read-only, it cannot answer, approve or endorse',
  args: z.object({ questions: z.boolean().optional(), json: z.boolean().optional() }).strict(),
  result: Report,
  cli: {
    options: {
      questions: { long: '--questions', description: 'only open questions' },
      json: { long: '--json', description: 'print one JSON object: { items }' },
    },
  },
  async run({ questions, json }, ctx) {
    const { items } = await readQueue(ctx)
    const shown = questions ? items.filter(item => item.kind === 'question') : items
    return { ok: true, lines: json ? [JSON.stringify({ items: shown })] : describeItems(shown) }
  },
})
