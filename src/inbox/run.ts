import fs from 'node:fs'
import type { ServerMessage } from '../protocol.js'
import type { Report, VerbContext } from '../cli/command.js'
import { noTerminal } from '../cli/verbs/endorse.js'
import { applyActions } from './apply.js'
import { batchId, buildBatch, type BatchItem } from './batch.js'
import { parseAnswers, type Action } from './parse.js'
import { renderBatch } from './render.js'
import { readSnapshot, writeSnapshot } from './snapshot.js'

async function currentBatch(ctx: VerbContext): Promise<BatchItem[]> {
  const res = (await ctx.withBroker(b => b.request({ t: 'queue' }, 'queue_result'))) as Extract<
    ServerMessage,
    { t: 'queue_result' }
  >
  return buildBatch(res)
}

/** Print every open item numbered, and remember what each number means for the answers to come. */
export async function printBatch(ctx: VerbContext): Promise<Report> {
  const items = await currentBatch(ctx)
  const id = batchId(items)
  writeSnapshot({ batch: id, items: items.map(({ n, msgId, section }) => ({ n, msgId, section })) })
  return { ok: true, lines: renderBatch(items, id) }
}

/** Validate every answer against the printed batch and the live queue, then send them or none. */
export async function answerBatch(input: string, ctx: VerbContext): Promise<Report> {
  const snapshot = readSnapshot()
  if (snapshot === undefined)
    return { ok: false, lines: [], errors: ['no batch to answer; run agent-chat inbox --batch first'] }
  const { actions, errors } = parseAnswers(input, snapshot, await currentBatch(ctx))
  if (errors.length > 0) return { ok: false, lines: ['Nothing sent.'], errors }
  const unconfirmable = ctx.terminal?.isTTY ? [] : endorsements(actions).flatMap(withoutTerminal)
  if (unconfirmable.length > 0) return { ok: false, lines: ['Nothing sent.'], errors: unconfirmable }
  if (actions.length === 0) return { ok: true, lines: ['No answers filled in; nothing sent.'] }
  return applyActions(actions, ctx)
}

type EndorseAction = Extract<Action, { verb: 'endorse' }>

const endorsements = (actions: readonly Action[]): EndorseAction[] =>
  actions.filter((a): a is EndorseAction => a.verb === 'endorse')

/** Batch endorse follows the bare form's rule: no terminal, no endorsement (CC-419). */
const withoutTerminal = (a: EndorseAction): string[] =>
  noTerminal({ msgId: a.msgId, to: a.to, text: a.text }).map(line => `${a.n}: ${line}`)

/** `-` is stdin, so a heredoc or a pipe works as well as a file. */
export const readAnswers = (source: string): string => fs.readFileSync(source === '-' ? 0 : source, 'utf8')
