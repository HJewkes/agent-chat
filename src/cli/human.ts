import { type QueueItem, type ServerMessage } from '../protocol.js'
import { ago, fail, withBroker } from './client.js'

const LABEL: Record<string, string> = {
  question: 'ASK  ',
  approval_request: 'APPR ',
  notice: 'note ',
  message: 'msg  ',
  endorse_request: 'ENDR ',
}

/** Things that need an answer first; notices are just there when you look. */
const needsAnswer = (i: QueueItem): boolean =>
  i.kind === 'question' || i.kind === 'approval_request' || i.kind === 'endorse_request'

export async function inbox(): Promise<void> {
  const res = (await withBroker(b => b.request({ t: 'queue' }, 'queue_result'))) as Extract<
    ServerMessage,
    { t: 'queue_result' }
  >
  if (res.items.length === 0) {
    console.log('Nothing waiting.')
    return
  }
  const ordered = [...res.items].sort((a, b) => Number(needsAnswer(b)) - Number(needsAnswer(a)))

  for (const item of ordered) {
    console.log(`${LABEL[item.kind] ?? item.kind} ${item.msgId}  ${item.from.padEnd(14)} ${ago(item.at)}`)
    // The exact bytes that will be delivered, in full and untruncated. This
    // print IS the thing being endorsed — anything elided here would be
    // approved unread, which is the failure the whole flow exists to prevent.
    if (item.kind === 'endorse_request') {
      console.log(`      would be delivered to ${item.meta.recipient} as ${item.from}, with your authority:`)
      // CC-38: any free name is available to whoever registers it first.
      // recipient_durable distinguishes a broker-minted identity from a
      // self-chosen one that could belong to anybody.
      if (item.meta.recipient_durable === 'false') {
        const registeredAt = Number(item.meta.recipient_registered_at ?? Date.now())
        console.log(
          `      warning: "${item.meta.recipient}" has no durable Claude Code identity ` +
            `(registered ${ago(registeredAt)}) — a raw process could have claimed that name.`,
        )
      }
    }
    console.log(`      ${item.text}`)
    // For an approval the description is often just "Run shell command", so the
    // preview is the only place the actual command shows up.
    if (item.meta.input_preview) console.log(`      ${item.meta.input_preview.slice(0, 200)}`)
  }
  const open = res.items.filter(needsAnswer).length
  const blocked = res.items.filter(i => i.kind === 'approval_request')
  console.log(`\n${res.items.length} waiting, ${open} needing an answer.`)
  if (blocked.length > 0) {
    const who = [...new Set(blocked.map(i => i.from))].join(', ')
    console.log(`${who} blocked on a permission prompt — answer in that session's terminal.`)
  }
  if (open > blocked.length) console.log('answer with: agent-chat answer <id> "..."')
  if (res.items.some(i => i.kind === 'endorse_request')) {
    console.log('endorse with: agent-chat endorse <id>   (or dismiss <id> to decline)')
  }
}

/**
 * Approve one composed message and deliver it with the human's authority.
 *
 * A CLI verb and nothing else, for the same reason `teleport abort` is one: the
 * broker refuses this frame from any registered connection, so the only caller
 * that can reach it is a person at a 0600 socket. No text argument — the bytes
 * are the ones already stored and already shown by `inbox`, which is what makes
 * the delivered message necessarily the one that was read.
 */
export async function endorse(msgId: string): Promise<void> {
  const res = (await withBroker(b => b.request({ t: 'endorse_approve', msgId }, 'answer_result'))) as Extract<
    ServerMessage,
    { t: 'answer_result' }
  >
  if (!res.ok) fail(res.reason ?? 'refused')
  console.log(`Endorsed ${msgId}; delivered as written.${res.reason ? ` ${res.reason}` : ''}`)
}

export async function verdict(msgId: string, words: string[], verb: 'answer' | 'dismiss'): Promise<void> {
  if (verb === 'answer' && words.length === 0) fail('usage: agent-chat answer <id> <text>')

  const request =
    verb === 'answer'
      ? ({ t: 'answer', msgId, text: words.join(' ') } as const)
      : ({ t: 'dismiss', msgId } as const)

  const res = (await withBroker(b => b.request(request, 'answer_result'))) as Extract<
    ServerMessage,
    { t: 'answer_result' }
  >
  if (!res.ok) fail(res.reason ?? 'refused')
  console.log(
    verb === 'answer' ? `Answered ${msgId}.${res.reason ? ` ${res.reason}` : ''}` : `Dismissed ${msgId}.`,
  )
}
