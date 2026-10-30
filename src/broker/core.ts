import type net from 'node:net'
import {
  HUMAN,
  type AgentIdentity,
  type ClientMessage,
  type DecidedRefusal,
  type DecisionCitation,
  type DeliveredMessage,
  type AnswerChannel,
  type SurfaceName,
  type WakeSource,
  isInteractiveSurface,
} from '../protocol.js'
import { checkDecision, decidedText, overruleText } from './decisions.js'
import { AgentLog } from '../agents/identity.js'
import { resolveReportBatchMs, resolveSeatSteward } from '../config.js'
import { logEvent } from './log.js'
import { EventLog, isReport, isTerminalReport } from './event-log.js'
import { ReportBatcher, type Unpushed } from './report-batch.js'
import type { ExitJudgement } from './subscriptions.js'
import { StrandedReports } from './stranded-reports.js'
import type { AppendInput, EventStore, OpenEndorsement } from './event-store.js'
import { EventHub } from './events.js'
import { Registry, type IdentityBinding } from './registry.js'
import { ClaimLedger } from './claims.js'
import { pushHoldFor } from './push-hold.js'
import { SEAT_HOLD_MARK, heldMessages, holdVerdict } from './seat-hold.js'
import { TELEPORT_GAP_MS, midTeleport } from './teleport-window.js'

type RegisterMessage = Extract<ClientMessage, { t: 'register' }>

/**
 * CC-959: whether the name on this frame was derived from the session's
 * directory or chosen, as the frame states it. Recorded on every adoption and
 * attach so the fold never has to infer it, and a session merely opened in a
 * stopped agent's worktree does not supersede that agent.
 */
const provisionalMeta = (msg: RegisterMessage): { provisional: string } => ({
  provisional: msg.provisional === true ? 'true' : 'false',
})

/**
 * The register frame that puts a returning session back under the name the log
 * says it held. CC-959: the name is the one it held, so it stays exactly as
 * derived or as chosen as it was; the brief is no evidence either way.
 */
export function readoptRegistration(
  known: AgentIdentity,
  msg: Extract<ClientMessage, { t: 'readopt' }>,
): RegisterMessage {
  return {
    t: 'register',
    name: known.name,
    workingOn: known.brief === '' ? 'reconnected after its MCP server was replaced' : known.brief,
    cwd: msg.cwd,
    pid: msg.pid,
    sessionId: msg.sessionId,
    ...(known.provisionalName === true ? { provisional: true } : {}),
    ...(msg.hostPid === undefined ? {} : { hostPid: msg.hostPid }),
    ...(msg.host === undefined ? {} : { host: msg.host }),
    ...(msg.termSessionId === undefined ? {} : { termSessionId: msg.termSessionId }),
    ...(msg.observed === undefined ? {} : { observed: msg.observed }),
    ...(msg.build === undefined ? {} : { build: msg.build }),
  }
}

export type Conn = net.Socket

/**
 * Live delivery to a connected session, injected so the core never touches a
 * socket. Generic over the connection type so `BrokerCore` itself can be
 * instantiated over a non-socket transport (relay's fold-in target); every
 * existing caller passes no type argument and keeps getting `Conn`. Returning
 * `false` says the frame was not written, which keeps a report from counting as pushed.
 */
export type Deliver<C = Conn> = (conn: C, message: DeliveredMessage) => unknown

/** CC-420: the plan's proposed 24h default; the owner has not yet answered the max-age question. */
export const ENDORSE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** A headless agent exits seconds after its report; two minutes covers a slow Stop hook and no further work. */
export const CLOSING_ACT_MS = 120_000

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
export class BrokerCore<C = Conn> {
  readonly registry: Registry<C>
  readonly events: EventStore
  readonly hub: EventHub
  readonly agents: AgentLog
  readonly startedAt: number
  /** Live worktree/file claims, released with the connection that took them (CC-56). */
  readonly claims = new ClaimLedger()

  private readonly reports: ReportBatcher<C>
  private readonly isSeat: (name: string) => boolean
  /** CC-321: reports a connection closed on unpushed, by name, pushed to the next connection to take that name. */
  private readonly stranded = new StrandedReports()
  /** CC-1140: the log id a non-seat name went dark at, read as it registers, until its missed answers are pushed. */
  private readonly missedSince = new Map<string, number>()
  private readonly watchers = new Set<(row: AppendInput) => void>()
  /** CC-1554: routed mail a parked agent was not pushed, by agent id, oldest first, until it is unparked. */
  private readonly parkedMail = new Map<string, DeliveredMessage[]>()

  constructor(deliver: Deliver<C>, options: BrokerCoreOptions<C> = {}) {
    this.events = options.events ?? new EventLog(options.dbPath)
    this.reports = new ReportBatcher<C>(deliver, options.reportBatchMs ?? resolveReportBatchMs, () =>
      this.mintMsgId(),
    )
    this.isSeat = options.isSeat ?? (() => false)
    this.registry = options.registry ?? new Registry<C>()
    this.hub = options.hub ?? new EventHub()
    this.agents = new AgentLog(this.events)
    this.registry.holdPushesWhen(agentId => pushHoldFor(this.events, this.agents, agentId))
    this.startedAt = Date.now()
  }

  /** CC-1188: a log-checked id for a caller that needs one before it appends, or never logs it. */
  mintMsgId(): string {
    return this.events.mintMsgId()
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
    this.flushParkedMail(input)
    return written
  }

  /** CC-1554: keep a routed message held from a parked agent, for the push its unpark makes. */
  holdWhileParked(target: C, message: DeliveredMessage): void {
    const agentId = this.registry.entryFor(target)?.agentId
    if (agentId === undefined) return
    this.parkedMail.set(agentId, [...(this.parkedMail.get(agentId) ?? []), message])
  }

  /**
   * CC-1554: a resume, a resumed session attaching, or the human's first word to a park
   * teleport's successor can unpark an agent, as can that successor's own peer work; its
   * held mail is then pushed in order. A retired agent's is dropped, since it stays in the
   * inbox and nothing will wake it.
   */
  private flushParkedMail(input: AppendInput): void {
    if (this.parkedMail.size === 0) return
    this.flushMailOf(this.agentOfRow(input))
    if (input.kind === 'agent_spawned' || input.kind === 'message')
      this.flushMailOf(this.agentConnectedAs(input.actor))
  }

  private flushMailOf(agentId: string | undefined): void {
    const held = agentId === undefined ? undefined : this.parkedMail.get(agentId)
    if (agentId === undefined || held === undefined) return
    const hold = pushHoldFor(this.events, this.agents, agentId)
    if (hold === 'retired') this.parkedMail.delete(agentId)
    const conn = this.registry.connFor(this.agents.get(agentId)?.name ?? '')
    if (hold !== undefined || conn === undefined || this.registry.entryFor(conn)?.agentId !== agentId) return
    this.parkedMail.delete(agentId)
    for (const message of held) this.reports.now(conn, message)
    logEvent('parked_mail_delivered', { agentId, count: held.length })
  }

  /** The agent a row's resume or attach names, or else the one connected under its target. */
  private agentOfRow(input: AppendInput): string | undefined {
    if (input.kind === 'agent_resumed' || input.kind === 'agent_attached') return input.ref
    return input.target === undefined ? undefined : this.agentConnectedAs(input.target)
  }

  private agentConnectedAs(name: string): string | undefined {
    const conn = this.registry.connFor(name)
    return conn === undefined ? undefined : this.registry.entryFor(conn)?.agentId
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
  claimable(agentId: string, name: string): { ok: true } | { ok: false; reason: string } {
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
  register(conn: C, msg: RegisterMessage, evict?: (conn: C) => void): { ok: boolean; reason?: string } {
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
    const missedSince = this.answersMissedSince(msg.name)
    const result = this.registry.register(conn, msg, this.teleportPredecessor(msg.agentId))
    logEvent(result.ok ? 'registered' : 'register_rejected', { name: msg.name, reason: result.reason })
    if (!result.ok) return { ok: false, ...(result.reason === undefined ? {} : { reason: result.reason }) }
    if (missedSince === undefined) this.missedSince.delete(msg.name)
    else this.missedSince.set(msg.name, missedSince)
    if (result.evicted !== undefined)
      this.supersede(msg.name, msg.agentId, result.evictedAgentId, result.evicted, evict)

    this.append({ kind: 'registered', actor: msg.name, body: msg.workingOn, meta: { cwd: msg.cwd } })
    this.noteWorkingOnCollision(msg)
    // Resolved from the session id, so a session on a new socket re-attaches to
    // the identity it already has. Minting happens only here, after a successful
    // registration: mint any earlier and a name that turned out to be held leaves
    // an identity behind with nothing able to attach to it.
    const bound = this.resolveIdentity(msg)
    if (bound !== undefined) {
      const { agentId, binding } = bound
      this.registry.bindIdentity(conn, agentId, binding)
      this.append({
        kind: 'agent_attached',
        actor: msg.name,
        ref: agentId,
        body: msg.workingOn,
        ...this.attachMeta(msg, agentId),
      })
    }
    return { ok: true }
  }

  /** CC-1614: `launch` only for an id `claimable()` accepted above; a session-id match is not checked against the name. */
  private resolveIdentity(msg: RegisterMessage): { agentId: string; binding: IdentityBinding } | undefined {
    if (msg.agentId !== undefined) return { agentId: msg.agentId, binding: 'launch' }
    const known = this.agents.bySession(msg.sessionId ?? '')?.agentId
    if (known !== undefined) return { agentId: known, binding: 'session' }
    const adopted = this.adopt(msg)
    return adopted === undefined ? undefined : { agentId: adopted, binding: 'adopted' }
  }

  private attachMeta(msg: RegisterMessage, agentId: string): { meta?: Record<string, string> } {
    if (msg.agentId === undefined) return { meta: provisionalMeta(msg) }
    const movedFrom = this.movedFrom(agentId)
    return movedFrom === undefined ? {} : { meta: { account_from: movedFrom } }
  }

  /** CC-892: an account-moved successor's first attach says where it moved from, which a seat's file follows. */
  private movedFrom(agentId: string): string | undefined {
    const rows = this.events.agentEventsFor(agentId)
    const from = rows.find(r => r.kind === 'agent_spawned')?.meta.account_from
    if (from === undefined || rows.some(r => r.kind === 'agent_attached')) return undefined
    return from
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

  /**
   * CC-951: the predecessor a still-spawning teleport successor may evict, so the
   * old session ends only once the new one holds the name. Spawning only: once
   * attached, the successor's id is an ordinary one again.
   */
  private teleportPredecessor(agentId: string | undefined): string | undefined {
    const identity = agentId === undefined ? undefined : this.agents.get(agentId)
    return identity?.state === 'spawning' ? identity.teleportFrom : undefined
  }

  /** A takeover displaced a live connection: record the detach and close it. */
  private supersede(
    name: string,
    agentId: string | undefined,
    evictedAgentId: string | undefined,
    evicted: C,
    evict?: (conn: C) => void,
  ): void {
    const reason = evictedAgentId === agentId ? 'superseded by resume' : 'superseded by teleport successor'
    // The predecessor's own close handler would append this too, but it may not
    // have fired yet and the entry is already gone — so record it here, and let
    // drop() find nothing left to record when it does fire.
    if (evictedAgentId !== undefined)
      this.append({ kind: 'agent_detached', actor: name, ref: evictedAgentId, body: reason })
    this.strand(name, this.reports.forget(evicted))
    logEvent('deregistered', { name, reason })
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
        // CC-959: observed by the MCP subprocess, so the roster can show which account a hand-started seat bills.
        ...(msg.observed?.configDir ? { config_dir: msg.observed.configDir } : {}),
        ...provisionalMeta(msg),
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
  drop(conn: C): void {
    const entry = this.registry.entryFor(conn)
    const name = this.registry.drop(conn)
    const unpushed = this.reports.forget(conn)
    if (!name || !entry) return
    this.strand(name, unpushed)
    this.releaseClaims(name)
    logEvent('deregistered', { name, reason: 'connection closed' })
    this.append({ kind: 'deregistered', actor: name, body: entry.workingOn, meta: { status: entry.status } })
    if (entry.agentId !== undefined)
      this.append({ kind: 'agent_detached', actor: name, ref: entry.agentId, body: 'connection closed' })
  }

  /**
   * Claims are leases held by presence, so they end with the connection rather
   * than needing to be reaped: an agent that dies mid-task stops blocking its
   * peers at once (CC-56). A teleport is the exception (CC-397): the successor
   * keeps the name, so it keeps the claims too, unless it never arrives.
   */
  private releaseClaims(name: string): void {
    if (!midTeleport(this.events, name, Date.now())) {
      this.claims.releaseAll(name)
      return
    }
    logEvent('claims_kept_for_teleport', { name })
    const gap = setTimeout(() => {
      if (this.registry.connFor(name) !== undefined) return
      this.claims.releaseAll(name)
      logEvent('claims_released_after_teleport_gap', { name })
    }, TELEPORT_GAP_MS)
    gap.unref()
  }

  private strand(name: string, unpushed: Unpushed): void {
    this.stranded.add(name, unpushed.messages, Date.now(), unpushed.settled)
  }

  /**
   * CC-1140: where a name registering out of the dark starts missing answers. A seat
   * or teleport is skipped: `deliverHeld` already pushes its answers.
   */
  private answersMissedSince(name: string): number | undefined {
    if (this.darkSeat(name) !== undefined) return undefined
    return this.events.darkSince(name)?.id
  }

  /**
   * Push `name`'s new connection the reports its last one closed on (CC-321), and the
   * answers to its own questions recorded while it was dark (CC-1140), once.
   */
  deliverStranded(name: string): void {
    this.deliverMissedAnswers(name)
    const conn = this.registry.connFor(name)
    if (conn === undefined) return
    const { messages, settled } = this.stranded.take(name, Date.now())
    if (messages.length > 0) {
      this.reports.resend(conn, messages)
      logEvent('stranded_reports_delivered', { name, count: messages.length })
    }
    // CC-337: after the resend, so an exit that waited on a stranded report is judged against it.
    for (const then of settled) then()
  }

  private deliverMissedAnswers(name: string): void {
    const afterId = this.missedSince.get(name)
    const conn = this.registry.connFor(name)
    if (afterId === undefined || conn === undefined) return
    this.missedSince.delete(name)
    const missed = this.events.answersToAskerSince(name, afterId, this.registry.entryFor(conn)?.agentId)
    for (const message of missed) this.reports.now(conn, message)
    if (missed.length > 0) logEvent('missed_answers_delivered', { name, count: missed.length })
  }

  /** Deliver to a named session if it happens to be connected right now. */
  deliverTo(name: string, message: DeliveredMessage): boolean {
    const target = this.registry.connFor(name)
    if (!target) return false
    this.reports.now(target, message)
    return true
  }

  /**
   * CC-1455: a push a print-mode host has not shown is logged as not delivered, whatever the socket
   * write did. One whose server spools it is `queued` for its inbox hook; one without never sees it.
   */
  private routeDelivered(
    name: string,
    live: boolean,
  ): { delivered: boolean; reason?: string; queued?: string[] } {
    const verdict = live ? this.registry.printVerdict(name) : undefined
    if (verdict === 'queued') return { delivered: false, queued: [name] }
    return verdict === 'headless_no_channel'
      ? { delivered: false, reason: 'headless_no_channel' }
      : { delivered: live }
  }

  /**
   * Push one routed peer message (CC-321). A worker's report to the session that
   * spawned it waits out the batch window; everything else goes at once. The
   * human, a `chat_ask` answer and an endorsed message never come through here.
   */
  pushRouted(sender: C, target: C, message: DeliveredMessage): void {
    if (this.isReportToSpawner(sender, target, message)) this.reports.report(target, message)
    else this.reports.now(target, message)
  }

  private isReportToSpawner(sender: C, target: C, message: DeliveredMessage): boolean {
    if (message.broadcast || !isReport(message.text)) return false
    const agentId = this.registry.entryFor(sender)?.agentId
    const spawner = agentId === undefined ? undefined : this.agents.get(agentId)?.spawnedBy
    return spawner !== undefined && spawner === this.registry.nameOf(target)
  }

  /** A resume starts a new run, and only a report made in this run counts. */
  runStartedAt(identity: AgentIdentity): number {
    return this.events.lastAgentEventAt(identity.agentId, 'agent_resumed') ?? identity.spawnedAt
  }

  /**
   * The spawner whose `agent_exited` notice would repeat what it already has (CC-321).
   * CC-337: when that exit could be muted and the agent's report is still held, the window
   * is kept and `later` is called with the verdict once the batch is written, so a burst of
   * finished agents is one wake. Any other exit pushes the held report first, so the notice
   * never overtakes it.
   */
  reportedSpawner(
    agentId: string | undefined,
    exit: Record<string, string> = {},
    later: (spawner: string, muted: boolean) => void = () => undefined,
  ): ExitJudgement | undefined {
    const identity = agentId === undefined ? undefined : this.agents.get(agentId)
    if (identity === undefined) return undefined
    const exitAt = Date.now()
    const mutable = closedLikeCleanExit(identity, exit)
    const muted = (): boolean => mutable && this.closedWithReport(identity, exitAt)
    const spawner = this.registry.connFor(identity.spawnedBy)
    if (
      spawner !== undefined &&
      mutable &&
      this.reports.afterFlushFrom(spawner, identity.name, () => later(identity.spawnedBy, muted()))
    )
      return { spawner: identity.spawnedBy, deferred: true }
    if (spawner !== undefined) this.reports.flushFrom(spawner, identity.name)
    return muted() ? { spawner: identity.spawnedBy, deferred: false } : undefined
  }

  /**
   * The agent's newest message to its spawner in this run is a terminal report, written
   * to the spawner's open connection, shortly before it exited, with nothing sent back since.
   */
  private closedWithReport(identity: AgentIdentity, exitAt: number): boolean {
    const { name, spawnedBy } = identity
    const last = this.events.lastMessageFrom(name, { to: spawnedBy, since: this.runStartedAt(identity) })
    if (last === undefined || !isTerminalReport(last.text)) return false
    if (exitAt - last.at > CLOSING_ACT_MS || !this.reports.wasPushed(last.msgId)) return false
    return this.events.lastMessageFrom(spawnedBy, { to: name, since: last.at }) === undefined
  }

  /**
   * CC-320: keep a message for a dark seat, or (CC-301) for any name mid-teleport. Undefined
   * when `to` is neither, so the send fails as before; `ok: false` when the hold is full or
   * the name is dark too long.
   */
  holdForSeat(
    from: string,
    to: string,
    text: string,
    inReplyTo?: string,
    source?: WakeSource,
    sendMeta?: Record<string, string>,
  ): SeatHoldResult | undefined {
    if (!this.holdable(to)) return undefined
    const verdict = holdVerdict(this.events, to, Date.now())
    if (verdict === undefined) return undefined
    if (!verdict.hold) return { ok: false, reason: verdict.reason }
    const { msgId } = this.append({
      kind: 'message',
      actor: from,
      target: to,
      ...(inReplyTo === undefined ? {} : { ref: inReplyTo }),
      body: text,
      meta: {
        ...sendMeta,
        held: SEAT_HOLD_MARK,
        // CC-345: the episode survives a later boot, which would otherwise restart it at the new log opening.
        dark_id: String(verdict.dark.id),
        dark_at: String(verdict.dark.at),
        ...(source === undefined ? {} : { source }),
      },
    })
    logEvent('route', { kind: 'message', msgId, from, to, delivered: false, held: SEAT_HOLD_MARK })
    return { ok: true, msgId }
  }

  /**
   * CC-966: the steward `seatStewards` names for `seat`, unless it is `from`, so a steward's
   * own send to its dark seat is not handed back to it.
   */
  stewardFor(seat: string, from: string): string | undefined {
    const steward = resolveSeatSteward(seat)
    return steward === from ? undefined : steward
  }

  /**
   * CC-1501: a peer's message for a non-resident (parked or wrapped) seat goes to the owner queue, marked
   * as for the seat, instead of waking its steward (CC-966) with mail it cannot act on. Undefined when
   * `to` has no steward, or when `from` is that steward, so the caller falls through to `to`'s own hold.
   */
  queueForSeat(from: string, to: string, text: string, extras: SeatQueueExtras = {}): string | undefined {
    if (this.stewardFor(to, from) === undefined) return undefined
    const { inReplyTo, sendMeta } = extras
    const { msgId } = this.append({
      kind: 'message',
      actor: from,
      target: HUMAN,
      ...(inReplyTo === undefined ? {} : { ref: inReplyTo }),
      body: forwardedText(to, text),
      meta: { ...sendMeta, forwarded_for: to },
    })
    logEvent('route', { kind: 'message', msgId, from, to: HUMAN, delivered: true, forwardedFor: to })
    return msgId
  }

  /**
   * The log id of the dark episode seat `name` is in, read before it registers. CC-345: a name
   * no longer holdable, such as a seat stopped while dark, still gets the mail it was held.
   */
  darkSeat(name: string): number | undefined {
    const dark = this.events.darkSince(name)
    if (dark === undefined) return undefined
    return this.holdable(name) || this.events.hasHeldSince(name, dark.id) ? dark.id : undefined
  }

  /** CC-301: a teleport's successor keeps the name, so a send in the gap waits for it like a seat's. */
  private holdable(name: string): boolean {
    return this.isSeat(name) || midTeleport(this.events, name, Date.now())
  }

  /** Push what landed in a seat's inbox during the dark episode it just registered out of, oldest first. */
  deliverHeld(name: string, darkId: number): void {
    const held = heldMessages(this.events, name, darkId, Date.now())
    for (const message of held) this.deliverTo(name, message)
    if (held.length > 0) logEvent('seat_hold_delivered', { name, count: held.length })
  }

  /**
   * The human answering a queue item: recorded, then pushed live if the asker is
   * still up. `ok: true` with a `reason` means recorded but not delivered — the
   * asker is offline and will pick it up from its inbox, which is a query over
   * the log rather than a buffer, so nothing is lost.
   */
  answer(msgId: string, text: string, channel: AnswerChannel): VerdictResult {
    if (!this.events.isOpen(msgId)) return { ok: false, reason: `${msgId} is not an open item` }
    const author = this.events.authorOf(msgId)
    if (!author) return { ok: false, reason: `no item with id ${msgId}` }
    // A permission prompt is a verdict, answerable only from the socket's `approve_permission`; words never close one.
    if (this.events.isApprovalRequest(msgId))
      return { ok: false, reason: `${msgId} is a permission prompt; it is approved or denied, not answered` }

    // An answer on a decided question overrules the decider; the asker must be told which one stands.
    const decision = this.events.decisionFor(msgId)
    const overrule = decision && {
      event: 'overrule',
      overrules: decision.msgId,
      overruled_decider: decision.by,
    }
    // The body stays the human's own words: slice 1's precedent extract reads it as the answer.
    const written = this.append({
      kind: 'answer',
      actor: HUMAN,
      target: author,
      ref: msgId,
      body: text,
      meta: { ...overrule, channel },
    })
    const message: DeliveredMessage = {
      msgId: written.msgId,
      from: HUMAN,
      text: overrule ? overruleText(text, overrule) : text,
      inReplyTo: msgId,
      ...(overrule ? { event: 'overrule' } : {}),
      at: Date.now(),
    }

    const live = this.deliverTo(author, message)
    logEvent('route', {
      kind: 'answer',
      msgId: message.msgId,
      from: HUMAN,
      to: author,
      ...this.routeDelivered(author, live),
      ref: msgId,
    })
    return { ok: true, ...(live ? {} : { reason: `${author} is offline; queued in its inbox` }) }
  }

  /**
   * The decider answering a question on the human's behalf (autonomy slice 3).
   *
   * The second place `provenance` is set, mirroring `endorse`: the caller has
   * already proved the decider identity, the question text comes from the
   * stored row, and the marker comes from this method rather than any field
   * the decider sent. The question stays open so `answer` can overrule it.
   */
  decide(decider: string, msgId: string, text: string, citation: DecisionCitation): DecideResult {
    const question = this.events.undecidedQuestion(msgId)
    if (!question)
      return { ok: false, code: 'not_decidable', reason: `${msgId} is not an open, undecided question` }
    const check = checkDecision(question.text, text, citation)
    if (!check.ok) return check

    const written = this.append({
      kind: 'decided',
      actor: decider,
      target: question.from,
      ref: msgId,
      body: text,
      meta: { ...citation },
    })
    const message: DeliveredMessage = {
      msgId: written.msgId,
      from: decider,
      text: decidedText(text, decider, citation),
      inReplyTo: msgId,
      provenance: 'decided',
      event: 'decided',
      at: Date.now(),
    }
    const live = this.deliverTo(question.from, message)
    logEvent('route', {
      kind: 'decided',
      msgId: message.msgId,
      from: decider,
      to: question.from,
      ...this.routeDelivered(question.from, live),
      provenance: 'decided',
      ref: msgId,
    })
    return { ok: true, ...(live ? {} : { reason: `${question.from} is offline; queued in its inbox` }) }
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
   * - the approval must carry the stored text and recipient exactly (CC-418),
   *   so a person approving a command approved the bytes it names; anything
   *   else is refused, recorded, and leaves the request open.
   *
   * - the request must be younger than `ENDORSE_MAX_AGE_MS`, and the name must
   *   still belong to the agent it named, or its teleport successor (CC-420).
   *
   * Declining is `dismiss`: it closes the item and delivers nothing.
   *
   * `channel` names a non-socket human channel (TP-1989: `owner-console`) on the
   * rows this writes, for audit only. It changes no check.
   */
  endorse(msgId: string, approval: EndorseApproval, channel?: string): VerdictResult {
    const request = this.events.openEndorsement(msgId)
    if (!request) return { ok: false, reason: `${msgId} is not an open endorsement request` }
    const audit = channel === undefined ? {} : { meta: { channel } }
    const refusal = approvalMismatch(request, approval) ?? staleness(request) ?? this.recipientMoved(request)
    if (refusal) {
      this.append({ kind: 'verdict_refused', actor: HUMAN, ref: msgId, body: refusal, ...audit })
      return { ok: false, reason: refusal }
    }

    this.append({ kind: 'resolution', actor: HUMAN, ref: msgId, body: 'endorsed', ...audit })
    const written = this.append({
      kind: 'message',
      actor: request.composer,
      target: request.recipient,
      body: request.text,
      // `endorsed_from` rather than `ref`: the recipient never saw the request,
      // so surfacing it as an in-reply-to would show them a thread they were not
      // part of. The audit trail wants the edge; the conversation does not.
      meta: { provenance: 'human-endorsed', endorsed_from: msgId },
    })
    const message: DeliveredMessage = {
      msgId: written.msgId,
      from: request.composer,
      text: request.text,
      provenance: 'human-endorsed',
      at: Date.now(),
    }

    const live = this.deliverTo(request.recipient, message)
    logEvent('route', {
      kind: 'message',
      msgId: message.msgId,
      from: request.composer,
      to: request.recipient,
      ...this.routeDelivered(request.recipient, live),
      provenance: 'human-endorsed',
      ref: msgId,
    })
    return { ok: true, ...(live ? {} : { reason: `${request.recipient} is offline; queued in its inbox` }) }
  }

  /**
   * Why the recipient name no longer reaches the agent the human was shown, if it does not.
   *
   * Fails closed on a request with no stored agent id: the human can still dismiss it.
   * Offline, the line's latest identity must still hold the name, since its inbox is read by name.
   */
  private recipientMoved(request: OpenEndorsement): string | undefined {
    const { recipient, recipientAgentId } = request
    if (recipientAgentId === undefined)
      return `the request does not record which agent "${recipient}" was; dismiss it and ask for a new one`
    const line = this.agents.lineageFrom(recipientAgentId)
    const holder = this.registry.connFor(recipient)
    if (holder !== undefined) {
      const holderId = this.registry.entryFor(holder)?.agentId
      if (line.some(agent => agent.agentId === holderId)) return undefined
      return `"${recipient}" is now held by a different agent than the request named; nothing was delivered`
    }
    const latest = line.at(-1)
    if (latest && latest.state !== 'retired' && latest.name === recipient) return undefined
    return `the agent the request named no longer holds "${recipient}"; nothing was delivered`
  }

  /** Close an item without answering it. Resolution is an event, never a mutation. */
  dismiss(msgId: string): VerdictResult {
    if (!this.events.isOpen(msgId)) return { ok: false, reason: `${msgId} is not an open item` }
    this.append({ kind: 'resolution', actor: HUMAN, ref: msgId, body: 'dismissed' })
    return { ok: true }
  }

  close(): void {
    this.reports.flushAll()
    this.events.close()
  }
}

/** What the approver read: the exact text and recipient of the request they approve. */
export interface EndorseApproval {
  text: string
  to: string
}

/** Exact string equality only; a frame off the wire may lack either field, which refuses. */
function approvalMismatch(
  request: { recipient: string; text: string },
  approval: EndorseApproval | undefined,
): string | undefined {
  if (typeof approval?.text !== 'string' || approval.text !== request.text)
    return 'the approved text does not match the stored request; nothing was delivered'
  if (typeof approval.to !== 'string' || approval.to !== request.recipient)
    return 'the approved recipient does not match the stored request; nothing was delivered'
  return undefined
}

/** A prompt left open overnight should not deliver a decision that may no longer hold. */
function staleness(request: OpenEndorsement): string | undefined {
  if (Date.now() - request.at <= ENDORSE_MAX_AGE_MS) return undefined
  const hours = ENDORSE_MAX_AGE_MS / 3_600_000
  return `the request is older than ${hours}h; dismiss it and ask the composer to send it again`
}

/** Exit code 0 only: a signalled, inferred or never-started exit records no code at all. */
const exitedCleanly = (exit: Record<string, string>): boolean => exit.code === '0'

/**
 * CC-337: a visible pane is not the broker's child, so its agent's exit is only ever inferred
 * from presence and never carries a code. Such an exit counts as clean; a headless agent's
 * inferred exit is a reaped process that may have crashed, so it does not. An empty surface
 * is a row written before surfaces were recorded.
 */
function closedLikeCleanExit(identity: AgentIdentity, exit: Record<string, string>): boolean {
  if (exitedCleanly(exit)) return true
  if (
    exit.inferred !== 'true' ||
    exit.failed === 'true' ||
    exit.code !== undefined ||
    exit.signal !== undefined
  )
    return false
  return identity.surface !== '' && isInteractiveSurface(identity.surface as SurfaceName)
}

export interface VerdictResult {
  ok: boolean
  reason?: string
}

export type SeatHoldResult = { ok: true; msgId: string } | { ok: false; reason: string }

/** CC-966: how a queued message reads to the owner, naming the seat it was sent to. */
export const forwardedText = (seat: string, text: string): string => `[for ${seat}] ${text}`

/** What a message queued for a non-resident seat carries beyond its text. */
export interface SeatQueueExtras {
  inReplyTo?: string | undefined
  sendMeta?: Record<string, string> | undefined
}

export type DecideResult = { ok: true; reason?: string } | { ok: false; code: DecidedRefusal; reason: string }

export interface BrokerCoreOptions<C = Conn> {
  registry?: Registry<C>
  events?: EventStore
  hub?: EventHub
  dbPath?: string
  /** The report batch window in ms, asked per report; 0 turns batching off. Defaults to config (CC-321). */
  reportBatchMs?: () => number
  /** CC-320: whether a name is a watched seat, whose messages are held while it is dark. Nobody, when absent. */
  isSeat?: (name: string) => boolean
}
