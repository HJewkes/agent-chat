import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeInbox } from '../human.js'
import { answerBatch, printBatch, readAnswers } from '../../inbox/run.js'
import { defineVerb, Report } from '../command.js'

export const inboxVerb = defineVerb({
  name: 'human.inbox',
  description: 'what your agents need from you',
  args: z.object({ batch: z.boolean().optional(), answers: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      batch: { long: '--batch', description: 'every open item numbered, to answer in one go' },
      answers: {
        long: '--answers',
        description: 'with --batch, a file of "N: answer" lines, or - for stdin',
      },
    },
  },
  async run({ batch, answers }, ctx) {
    if (answers !== undefined && !batch)
      return { ok: false, lines: [], errors: ['--answers goes with --batch'] }
    if (batch) return answers === undefined ? printBatch(ctx) : answerBatch(readAnswers(answers), ctx)
    const res = (await ctx.withBroker(b => b.request({ t: 'queue' }, 'queue_result'))) as Extract<
      ServerMessage,
      { t: 'queue_result' }
    >
    return describeInbox(res)
  },
})
