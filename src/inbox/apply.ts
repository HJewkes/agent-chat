import type { ServerMessage } from '../protocol.js'
import type { Report, VerbContext } from '../cli/command.js'
import { approveVerb } from '../cli/verbs/approve.js'
import { dismissVerb } from '../cli/verbs/dismiss.js'
import { confirmAndEndorse } from '../cli/verbs/endorse.js'
import type { Action } from './parse.js'

/** The frame `agent-chat answer <id> <text>` sends; an overrule is the same frame on a decided id. */
async function answer(msgId: string, text: string, ctx: VerbContext): Promise<Report> {
  const res = (await ctx.withBroker(b =>
    b.request({ t: 'answer', msgId, text, channel: 'inbox-file' }, 'answer_result'),
  )) as Extract<ServerMessage, { t: 'answer_result' }>
  if (!res.ok) return { ok: false, lines: [], errors: [res.reason ?? 'refused'] }
  return { ok: true, lines: [`Answered ${msgId}.${res.reason ? ` ${res.reason}` : ''}`] }
}

/** Each answer runs through the single-item verb that owns it, so the broker sees the same frame. */
function dispatch(action: Action, ctx: VerbContext): Promise<Report> {
  const id = action.msgId
  switch (action.verb) {
    case 'answer':
      return answer(id, action.text, ctx)
    case 'approve':
      return approveVerb.run({ id, 'allow|deny': action.behavior }, ctx)
    case 'endorse':
      return confirmAndEndorse({ msgId: id, text: action.text, to: action.to }, ctx)
    case 'dismiss':
      return dismissVerb.run({ id }, ctx)
  }
}

/** Sequential, so the report reads in the file's order and one refusal cannot race another answer. */
export async function applyActions(actions: readonly Action[], ctx: VerbContext): Promise<Report> {
  const lines: string[] = []
  const errors: string[] = []
  for (const action of actions) {
    const report = await dispatch(action, ctx)
    lines.push(...report.lines.map(line => `${action.n}: ${line}`))
    errors.push(...(report.errors ?? []).map(error => `${action.n}: ${error}`))
  }
  lines.push(`${actions.length - errors.length} of ${actions.length} sent.`)
  return { ok: errors.length === 0, lines, ...(errors.length > 0 ? { errors } : {}) }
}
