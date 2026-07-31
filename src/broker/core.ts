import type net from 'node:net'
import { HUMAN, type ClientMessage, type DeliveredMessage } from '../protocol.js'
import { AgentLog } from '../agents/identity.js'
import { logEvent } from './log.js'
import { EventLog, newMsgId } from './event-log.js'
import type { AppendInput, EventStore } from './event-store.js'
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
  readonly events: EventStore
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
    // Deliberately NOT the resolved identity below: only an agent id the broker
    // minted and handed over in an environment may take a live name away from its
    // holder. A session id is merely evidence of which Claude Code process this
    // is, and letting it evict would turn the name lease — the property that makes
    // "held by another session" mean anything — into a claim anyone can make.
    const result = this.registry.register(conn, msg)
    logEvent(result.ok ? 'registered' : 'register_rejected', { name: msg.name, reason: result.reason })
    if (!result.ok) return { ok: false, ...(result.reason === undefined ? {} : { reason: result.reason }) }
    if (result.evicted !== undefined) this.supersede(msg.name, msg.agentId, result.evicted, evict)

    this.append({ kind: 'registered', actor: msg.name, body: msg.workingOn, meta: { cwd: msg.cwd } })
    this.noteWorkingOnCollision(msg)
    // Resolved from the session id, so a session on a new socket re-attaches to
    // the identity it already has. Minting happens only here, after a successful
    // registration: mint any earlier and a name that turned out to be held leaves
    // an identity behind with nothing able to attach to it.
    const known = msg.agentId ?? this.agents.bySession(msg.sessionId ?? '')?.agentId
    const agentId = known ?? this.adopt(msg)
    if (agentId !== undefined) {
      this.registry.bindIdentity(conn, agentId)
      this.append({ kind: 'agent_attached', actor: msg.name, ref: agentId, body: msg.workingOn })
    }
    return { ok: true }
  }

  /**
   * CC-9: two ordinary sessions bootstrapped from the same active-work
   * initiative in the same directory can end up with byte-for-byte identical
   * `workingOn` text — the bootstrap prompt is generic and has no awareness of
   * a sibling session. `chat_list` then shows two rows a human cannot tell
   * apart by anything but name.
   *
   * Posted to the human's queue rather than back to the registering session:
   * a warning surfaced in the tool result would land in that session's own
   * turn for a condition it did not cause and cannot fix alone (CC-16 — peer
   * conditions should not lengthen an unrelated turn). The human is the one
   * party who can see both sessions at once and decide whether to redirect
   * one of them.
   */
  private noteWorkingOnCollision(msg: RegisterMessage): void {
    const { name, workingOn, cwd } = msg
    const peers = this.registry.list().filter(s => s.name !== name)
    const sameText = peers.filter(s => s.cwd === cwd && s.workingOn.trim() === workingOn.trim())

    // CC-11 extends the SAME notice rather than adding a second path. Identical
    // `workingOn` text is only the visible half of the problem: two sessions that
    // wrote DIFFERENT descriptions of the same checkout collide on files just as
    // hard, and the text check cannot see it at all. An observed worktree can,
    // because it is derived from the process rather than typed by the model.
    const worktree = msg.observed?.worktreePath
    const sameTree =
      worktree === undefined
        ? []
        : peers.filter(s => s.observed?.worktreePath === worktree && !sameText.includes(s))
    if (sameText.length === 0 && sameTree.length === 0) return

    const branch = msg.observed?.gitBranch
    const lines: string[] = []
    if (sameText.length > 0)
      lines.push(
        `${name} registered in ${cwd} with the same "workingOn" text as ` +
          `${sameText.map(s => s.name).join(', ')} — chat_list will not distinguish them ` +
          'without looking at registeredAt.',
      )
    if (sameTree.length > 0)
      lines.push(
        `${name} is working in the same checkout as ${sameTree.map(s => s.name).join(', ')} ` +
          `(${worktree}${branch === undefined ? '' : `, branch ${branch}`}), so their edits land on ` +
          'the same files however differently they describe the work. Give one of them a worktree ' +
          'of its own, or decide which files each owns.',
      )

    this.append({ kind: 'notice', actor: 'agent-chat', target: HUMAN, body: lines.join(' ') })
    logEvent('working_on_collision', {
      name,
      cwd,
      collides_with: sameText.map(s => s.name),
      shares_worktree_with: sameTree.map(s => s.name),
    })
  }

  /** A takeover displaced a live connection: record the detach and close it. */
  private supersede(
    name: string,
    agentId: string | undefined,
    evicted: Conn,
    evict?: (conn: Conn) => void,
  ): void {
    // The predecessor's own close handler would append this too, but it may not
    // have fired yet and the entry is already gone — so record it here, and let
    // drop() find nothing left to record when it does fire.
    if (agentId !== undefined)
      this.append({ kind: 'agent_detached', actor: name, ref: agentId, body: 'superseded by resume' })
    logEvent('deregistered', { name, reason: 'superseded by resume' })
    evict?.(evicted)
  }

  /**
   * Mint a durable identity for an ordinary human-started session.
   *
   * The id comes from the broker, which is what stops identity becoming
   * self-asserted — but only half of the row is broker-derived. `session_id` and
   * `cwd` are read by the MCP subprocess from its own process; the name and the
   * body are whatever the model typed into `chat_register`, and `meta.origin`
   * records that so nothing downstream reads a self-chosen name as an assigned
   * one.
   *
   * `agent_spawned` is reused rather than given its own kind because the
   * EventKind union is frozen into the SSE contract, and the fold needs a row
   * that mints an id — which is precisely what this kind is.
   */
  private adopt(msg: RegisterMessage): string | undefined {
    if (!msg.sessionId) return undefined
    const { msgId: agentId } = this.append({
      kind: 'agent_spawned',
      actor: HUMAN,
      target: msg.name,
      body: msg.workingOn,
      meta: {
        origin: 'adopted',
        name: msg.name,
        cwd: msg.cwd,
        session_id: msg.sessionId,
        // Spawns this session requests are now its children, and depthOf() reads
        // the parent's recorded depth and adds one. Zero leaves them at exactly
        // the depth they had while a human session had no identity to be a
        // parent at all — anything else silently costs the fleet a level.
        depth: '0',
      },
    })
    return agentId
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

  /**
   * The human approving one composed message, which delivers it (CC-22).
   *
   * The ONLY place `provenance` is ever set. Three properties hold here and
   * nowhere else has to be trusted for them:
   *
   * - the text comes from the stored row, so the delivered bytes are the bytes
   *   the human was shown — the composer never gets to re-send;
   * - `openEndorsement` returns nothing once the item is closed, and the
   *   resolution below closes it, so approval is a grant over exactly one
   *   message rather than a standing one over a peer or a topic;
   * - `from` stays the composer, so the recipient sees endorsed-agent-words
   *   rather than something indistinguishable from the human speaking.
   *
   * Declining is `dismiss`: it closes the item and delivers nothing.
   */
  endorse(msgId: string): VerdictResult {
    const request = this.events.openEndorsement(msgId)
    if (!request) return { ok: false, reason: `${msgId} is not an open endorsement request` }

    this.append({ kind: 'resolution', actor: HUMAN, ref: msgId, body: 'endorsed' })
    const message: DeliveredMessage = {
      msgId: newMsgId(),
      from: request.composer,
      text: request.text,
      provenance: 'human-endorsed',
      at: Date.now(),
    }
    this.append({
      kind: 'message',
      actor: request.composer,
      target: request.recipient,
      msgId: message.msgId,
      body: request.text,
      // `endorsed_from` rather than `ref`: the recipient never saw the request,
      // so surfacing it as an in-reply-to would show them a thread they were not
      // part of. The audit trail wants the edge; the conversation does not.
      meta: { provenance: 'human-endorsed', endorsed_from: msgId },
    })

    const live = this.deliverTo(request.recipient, message)
    logEvent('route', {
      kind: 'message',
      msgId: message.msgId,
      from: request.composer,
      to: request.recipient,
      delivered: live,
      provenance: 'human-endorsed',
      ref: msgId,
    })
    return { ok: true, ...(live ? {} : { reason: `${request.recipient} is offline; queued in its inbox` }) }
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
  events?: EventStore
  hub?: EventHub
  dbPath?: string
}
