import { z } from 'zod'
import { positiveLimit, requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'
import { serviceRequest } from './ask.js'

type AnswersResult = Extract<ServerMessage, { t: 'answers_since_result' }>

/** The broker clamps to its own batch cap; asking for that cap by default reads a whole page. */
const DEFAULT_LIMIT = 50

function describeAnswers({ t: _kind, ...body }: AnswersResult, json: boolean | undefined): Report {
  if (body.error) return { ok: false, lines: [], errors: [body.error] }
  if (json) return { ok: true, lines: [JSON.stringify(body)] }
  return {
    ok: true,
    lines: body.answers.map(a => `${a.outcome} ${a.questionId} ${a.msgId}: ${a.text}`),
  }
}

/**
 * The read-back half of `ask` (CC-169): answers and dismissals to a label's asks,
 * oldest first. Pass the last `next` as `--since` to read only what is new.
 */
export const answersVerb = defineVerb({
  name: 'service.answers',
  description: "read answers and dismissals to a service label's asks",
  args: z.object({
    name: requiredString('name'),
    since: z.string().optional(),
    limit: positiveLimit('limit').optional(),
    json: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      since: { long: '--since <msgId>', description: 'only rows after this msg_id: an ask, or a last next' },
      limit: { long: '--limit <n>', description: `at most this many rows (default ${DEFAULT_LIMIT})` },
      json: { long: '--json', description: 'print the reply as one JSON object: { answers, next? }' },
    },
  },
  async run({ name, since, limit, json }, ctx) {
    const frame = {
      t: 'answers_since',
      name,
      limit: limit ?? DEFAULT_LIMIT,
      ...(since === undefined ? {} : { after: since }),
    } as const
    const res = (await serviceRequest(ctx, frame, 'answers_since_result')) as AnswersResult
    return describeAnswers(res, json)
  },
})
