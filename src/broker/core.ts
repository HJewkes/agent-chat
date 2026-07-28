import type net from 'node:net'
import { HUMAN, type ClientMessage, type DeliveredMessage } from '../protocol.js'
import { AgentLog } from '../agents/identity.js'
import { logEvent } from './log.js'
import { EventLog, newMsgId, type AppendInput } from './event-log.js'
import { EventHub } from './events.js'
import { Registry } from './registry.js'

type RegisterMessage = Extract<ClientMessage, { t: 'register' }>

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
  readonly agents: AgentLog
  readonly startedAt: number

  private readonly deliver: Deliver
  private readonly watchers = new Set<(row: AppendInput) => void>()

  constructor(deliver: Deliver, options: BrokerCoreOptions = {}) {
    this.deliver = deliver
    this.registry = options.registry ?? new Registry<Conn>()
    this.events = options.events ?? new EventLog(options.dbPath)
    this.hub = options.hub ?? new EventHub()
    this.agents = new AgentLog(this.events)
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
    // Typed, and separate from the hub on purpose: the hub speaks stringly SSE
    // frames for browsers, and the supervisor needs the row itself rather than a
    // re-parse of its own JSON. Same single write path feeds both.
    for (const watch of this.watchers) {
      try {
        watch(input)
      } catch {
        // A watcher must never be able to fail a write that already happened.
      }
    }
    return written
  }

  /** Observe every appended row. Returns its own unsubscribe. */
  onAppend(watch: (row: AppendInput) => void): () => void {
    this.watchers.add(watch)
    return () => {
      this.watchers.delete(watch)
    }
  }

  /**
   * Can this connection claim `agentId` under `name`?
   *
   * The check that matters is the name match. An agent id is an 8-char slice and
   * is visible in the log to every session on the machine, so without this a
   * session could register as an agent it merely read about and inherit that
   * agent's peers, its brief, and whatever authority the roster implies. Binding
   * the id to the name it was spawned under makes a stolen id useless on its own.
   */
  private claimable(agentId: string, name: string): { ok: true } | { ok: false; reason: string } {
    const identity = this.agents.get(agentId)
    if (!identity) return { ok: false, reason: `no agent with id ${agentId}` }
    if (identity.name !== name)
      return { ok: false, reason: `agent ${agentId} is "${identity.name}", not "${name}"` }
    // Retirement frees the name, so another agent may already hold it. Attaching
    // would resurrect an identity whose isolation has already been released.
    if (identity.state === 'retired') return { ok: false, reason: `agent ${agentId} has been retired` }
    return { ok: true }
  }

  /**
   * The one registration path. Presence goes in the registry and dies with the
   * socket; attaching and detaching go in the log and outlive it.
   *
   * `evict` closes a connection the takeover displaced. Injected because the core
   * holds no sockets — same reason `deliver` is.
   */
  register(conn: Conn, msg: RegisterMessage, evict?: (conn: Conn) => void): { ok: boolean; reason?: string } {
    if (msg.agentId !== undefined) {
      const claim = this.claimable(msg.agentId, msg.name)
      if (!claim.ok) {
        logEvent('register_rejected', { name: msg.name, agentId: msg.agentId, reason: claim.reason })
        return { ok: false, reason: claim.reason }
      }
    }

    const result = this.registry.register(conn, msg)
    logEvent(result.ok ? 'registered' : 'register_rejected', { name: msg.name, reason: result.reason })
    if (!result.ok) return { ok: false, ...(result.reason === undefined ? {} : { reason: result.reason }) }

    if (result.evicted !== undefined) {
      // The predecessor's own close handler would append this too, but it may not
      // have fired yet and the entry is already gone — so record it here, and let
      // drop() find nothing left to record when it does fire.
      if (msg.agentId !== undefined)
        this.append({
          kind: 'agent_detached',
          actor: msg.name,
          ref: msg.agentId,
          body: 'superseded by resume',
        })
      logEvent('deregistered', { name: msg.name, reason: 'superseded by resume' })
      evict?.(result.evicted)
    }

    this.append({ kind: 'registered', actor: msg.name, body: msg.workingOn, meta: { cwd: msg.cwd } })
    if (msg.agentId !== undefined)
      this.append({ kind: 'agent_attached', actor: msg.name, ref: msg.agentId, body: msg.workingOn })
    return { ok: true }
  }

  /** The socket went away. Presence ends; the identity does not. */
  drop(conn: Conn): void {
    const entry = this.registry.entryFor(conn)
    const name = this.registry.drop(conn)
    if (!name || !entry) return
    logEvent('deregistered', { name, reason: 'connection closed' })
    this.append({ kind: 'deregistered', actor: name, body: entry.workingOn, meta: { status: entry.status } })
    if (entry.agentId !== undefined)
      this.append({ kind: 'agent_detached', actor: name, ref: entry.agentId, body: 'connection closed' })
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
