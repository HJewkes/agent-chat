import type { DeliveredMessage } from '../protocol.js'
import { newMsgId } from './event-log.js'
import { logEvent } from './log.js'

/**
 * CC-321: one wake per burst of finished agents.
 *
 * A coordinator pays a whole-context turn for every push. Workers that finish
 * close together each send it a report, so their reports wait out one short
 * window and go as a single push. Nothing here writes or withholds a log row:
 * every message is in the recipient's inbox before it is offered, so a batch
 * that is never pushed is a missed wake and never a lost message.
 */

/** The `event` on a coalesced push, and the broker-log line an analyst counts. */
export const REPORT_BATCH = 'report-batch'

/** Report ids remembered as pushed; far more than are ever in flight between a report and its exit. */
export const MAX_REMEMBERED = 1024

/** `false` says the frame was not written; any other return, from a transport that cannot tell, says it was. */
type Push<C> = (conn: C, message: DeliveredMessage) => unknown

interface Held {
  messages: DeliveredMessage[]
  timer?: NodeJS.Timeout
}

export class ReportBatcher<C> {
  private readonly held = new Map<C, Held>()
  /** Each report whose frame was written, and the connection it was written to. */
  private readonly pushed = new Map<string, C>()

  constructor(
    private readonly push: Push<C>,
    private readonly windowMs: () => number,
  ) {}

  /** A report: held until its window ends. The first one starts the clock and later ones do not extend it. */
  report(conn: C, message: DeliveredMessage): void {
    const waiting = this.held.get(conn)
    if (waiting) return void waiting.messages.push(message)
    const windowMs = this.windowMs()
    if (windowMs <= 0) return this.write(conn, [message])
    // Unref'd: a held report is already in the log and must never keep the broker alive.
    const timer = setTimeout(() => this.flush(conn), windowMs).unref()
    this.held.set(conn, { messages: [message], timer })
  }

  /** Anything else: pushed at once, behind whatever is held for the same connection so order is kept. */
  now(conn: C, message: DeliveredMessage): void {
    this.flush(conn)
    this.push(conn, message)
  }

  /** True only once the report's frame was written to a connection that is still open. */
  wasPushed(msgId: string): boolean {
    return this.pushed.has(msgId)
  }

  /** The connection is gone: what it was pushed no longer counts, and what it was only held is returned. */
  forget(conn: C): DeliveredMessage[] {
    for (const [msgId, to] of this.pushed) if (to === conn) this.pushed.delete(msgId)
    const waiting = this.held.get(conn)
    if (!waiting) return []
    clearTimeout(waiting.timer)
    this.held.delete(conn)
    return waiting.messages
  }

  flush(conn: C): void {
    const waiting = this.held.get(conn)
    if (!waiting) return
    clearTimeout(waiting.timer)
    this.held.delete(conn)
    this.write(conn, waiting.messages)
  }

  /** Ends the window early when it holds a report from `sender`, so that sender's exit notice cannot overtake it. */
  flushFrom(conn: C, sender: string): void {
    if (this.held.get(conn)?.messages.some(m => m.from === sender)) this.flush(conn)
  }

  /** Reports a closed connection was never pushed, for the connection that now holds its name. */
  resend(conn: C, messages: DeliveredMessage[]): void {
    this.flush(conn)
    this.write(conn, messages)
  }

  /** A clean shutdown pushes what is held rather than leaving it for the next `chat_inbox`. */
  flushAll(): void {
    for (const conn of [...this.held.keys()]) this.flush(conn)
  }

  private write(conn: C, messages: DeliveredMessage[]): void {
    const [first] = messages
    if (first === undefined) return
    // Unwritten reports stay held with no timer, so closing the connection hands them to its successor.
    if (!this.written(conn, messages.length === 1 ? first : batchOf(messages)))
      return void this.held.set(conn, { messages })
    if (messages.length > 1) logBatch(messages)
    for (const message of messages) this.remember(message.msgId, conn)
  }

  /** A closed socket must not cost the other coordinators their batch, nor throw out of a timer. */
  private written(conn: C, frame: DeliveredMessage): boolean {
    try {
      return this.push(conn, frame) !== false
    } catch {
      return false
    }
  }

  private remember(msgId: string, conn: C): void {
    this.pushed.set(msgId, conn)
    if (this.pushed.size <= MAX_REMEMBERED) return
    const [oldest] = this.pushed.keys()
    if (oldest !== undefined) this.pushed.delete(oldest)
  }
}

function logBatch(messages: readonly DeliveredMessage[]): void {
  logEvent(REPORT_BATCH, { count: messages.length, msgIds: messages.map(m => m.msgId) })
}

/**
 * Every report whole and in arrival order, under a header naming its sender and
 * id. The headers are inside peer-written text and so can be imitated by it;
 * `batch` is the broker's own list and is what the recipient's attributes show.
 */
export function batchOf(messages: readonly DeliveredMessage[]): DeliveredMessage {
  const total = messages.length
  const senders = [...new Set(messages.map(m => m.from))].join(', ')
  const parts = messages.map((m, i) => `[${i + 1}/${total}] ${headerOf(m)}\n${m.text}`)
  return {
    msgId: newMsgId(),
    from: 'agent-chat',
    text:
      `${total} reports from peers (${senders}), delivered together. Each is that peer's own message: ` +
      `answer one with in_reply_to set to its msg_id.\n\n${parts.join('\n\n')}`,
    event: REPORT_BATCH,
    batch: messages.map(m => ({ msgId: m.msgId, from: m.from })),
    at: Date.now(),
  }
}

const headerOf = (m: DeliveredMessage): string =>
  `from ${m.from}, msg_id ${m.msgId}${m.inReplyTo ? `, in_reply_to ${m.inReplyTo}` : ''}`
