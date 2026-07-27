import type net from 'node:net'
import { HUMAN, type DeliveredMessage } from '../protocol.js'
import { logEvent } from './log.js'
import { EventLog, newMsgId, type AppendInput } from './event-log.js'
import { EventHub } from './events.js'
import { Registry } from './registry.js'

export type Conn = net.Socket

/** Live delivery to a connected session, injected so the core never touches a socket. */
export type Deliver = (conn: Conn, message: DeliveredMessage) => void

/**
 * The broker's state and its only write path.
 *
 * This replaces the module-level `registry` / `events` singletons that used to
 * live in `index.ts`, where `events` was assigned inside `startBroker()` and was
 * therefore `undefined` to anything that imported it earlier. Ownership by an
 * explicit object removes that ordering hazard entirely rather than documenting
 * around it.
 *
 * Two invariants the rest of the design leans on:
 *
 * - `append()` is the ONLY place rows are written, so hub fan-out is a side
 *   effect of writing rather than a second reader that can drift from the log.
 * - `answer()` / `dismiss()` are the only verdict paths. The socket handler and
 *   (later) the HTTP route both call them. That is one write path with two
 *   callers, not two write paths.
 *
 * Transport stays outside: `deliver` is injected, and turning a result into a
 * `ServerMessage` on a socket is the caller's job.
 */
export class BrokerCore {
  readonly registry: Registry<Conn>
  readonly events: EventLog
  readonly hub: EventHub
  readonly startedAt: number

  private readonly deliver: Deliver

  constructor(deliver: Deliver, options: BrokerCoreOptions = {}) {
    this.deliver = deliver
    this.registry = options.registry ?? new Registry<Conn>()
    this.events = options.events ?? new EventLog(options.dbPath)
    this.hub = options.hub ?? new EventHub()
    this.startedAt = Date.now()
  }

  /**
   * Append to the log and fan out to live subscribers. The fan-out carries the
   * row id so a reconnecting client can resume from a cursor without re-reading
   * the whole log.
   */
  append(input: AppendInput): { id: number; msgId: string } {
    const written = this.events.append(input)
    this.hub.broadcast({
      event: 'append',
      data: JSON.stringify({ id: written.id, msgId: written.msgId, kind: input.kind, actor: input.actor }),
    })
    return written
  }

  /** Deliver to a named session if it happens to be connected right now. */
  deliverTo(name: string, message: DeliveredMessage): boolean {
    const target = this.registry.connFor(name)
    if (!target) return false
    this.deliver(target, message)
    return true
  }

  /**
   * The human answering a queue item: recorded, then pushed live if the asker is
   * still up. `ok: true` with a `reason` means recorded but not delivered — the
   * asker is offline and will pick it up from its inbox, which is a query over
   * the log rather than a buffer, so nothing is lost.
   */
  answer(msgId: string, text: string): VerdictResult {
    if (!this.events.isOpen(msgId)) return { ok: false, reason: `${msgId} is not an open item` }
    const author = this.events.authorOf(msgId)
    if (!author) return { ok: false, reason: `no item with id ${msgId}` }

    const message: DeliveredMessage = {
      msgId: newMsgId(),
      from: HUMAN,
      text,
      inReplyTo: msgId,
      at: Date.now(),
    }
    this.append({
      kind: 'answer',
      actor: HUMAN,
      target: author,
      msgId: message.msgId,
      ref: msgId,
      body: text,
    })

    const live = this.deliverTo(author, message)
    logEvent('route', {
      kind: 'answer',
      msgId: message.msgId,
      from: HUMAN,
      to: author,
      delivered: live,
      ref: msgId,
    })
    return { ok: true, ...(live ? {} : { reason: `${author} is offline; queued in its inbox` }) }
  }

  /** Close an item without answering it. Resolution is an event, never a mutation. */
  dismiss(msgId: string): VerdictResult {
    if (!this.events.isOpen(msgId)) return { ok: false, reason: `${msgId} is not an open item` }
    this.append({ kind: 'resolution', actor: HUMAN, ref: msgId, body: 'dismissed' })
    return { ok: true }
  }

  close(): void {
    this.events.close()
  }
}

export interface VerdictResult {
  ok: boolean
  reason?: string
}

export interface BrokerCoreOptions {
  registry?: Registry<Conn>
  events?: EventLog
  hub?: EventHub
  dbPath?: string
}
