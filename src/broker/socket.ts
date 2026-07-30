import net from 'node:net'
import fs from 'node:fs'
import {
  encode,
  lineReader,
  HUMAN,
  type ClientMessage,
  type DeliveredMessage,
  type ServerMessage,
} from '../protocol.js'
import { cliEntry, home, socketPath } from '../paths.js'
import { logEvent } from './log.js'
import { newMsgId } from './event-log.js'
import { type Escalation, type RouteResult } from './registry.js'
import { BrokerCore, type Conn } from './core.js'
import { Supervisor } from '../agents/supervisor.js'
import type { SwitchOutcome } from '../agents/mode-switch.js'
import { SystemEventFeed } from './subscriptions.js'
import {
  probeSocket,
  readPidFile,
  removeStateFiles,
  watchSocket,
  writeMeta,
  writePidFile,
} from './lifecycle.js'
import { VERSION } from './version.js'

const MAX_OPEN_QUESTIONS = 3

/**
 * Endorsement requests one session may have waiting at once.
 *
 * Lower than the question budget on purpose: each one asks the human to read a
 * whole message word for word and take responsibility for it, which is a more
 * expensive ask than answering a question — and a backlog of them is exactly the
 * condition under which they stop being read carefully and start being
 * rubber-stamped.
 */
const MAX_OPEN_ENDORSEMENTS = 2

const reply = (conn: Conn, message: ServerMessage): void => {
  conn.write(encode(message))
}

const deliver = (conn: Conn, message: DeliveredMessage): void => {
  reply(conn, { t: 'deliver', message })
}

/** Both switch directions answer on one frame, so they serialise it the same way. */
const replySwitch = (conn: Conn, outcome: SwitchOutcome): void => {
  reply(conn, {
    t: 'switch_result',
    ok: outcome.ok,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.name === undefined ? {} : { name: outcome.name }),
    ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
    ...(outcome.surface === undefined ? {} : { surface: outcome.surface }),
    ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
  })
}

/**
 * The socket transport. Everything here is about turning bytes into `core`
 * calls and results back into bytes; all state and every write to the log lives
 * in `BrokerCore`.
 */
export class SocketServer {
  private readonly supervisor: Supervisor
  private readonly feed: SystemEventFeed<Conn>
  private readonly unwatch: () => void

  constructor(private readonly core: BrokerCore) {
    this.feed = new SystemEventFeed<Conn>(core.registry, (conn, events) => {
      reply(conn, { t: 'system_events', events })
    })
    // Fed from the single write path, so a subscriber sees exactly what the log
    // recorded rather than a second notion of what happened.
    this.unwatch = core.onAppend(row => this.feed.offer(row))
    // The broker owns the supervisor, not the requesting session: an agent must
    // outlive whoever asked for it, and the semaphore and depth cap need exactly
    // one enforcement point. The anchor comes from the requester's OWN registry
    // entry, so nobody can spawn into a pane they do not hold.
    this.supervisor = new Supervisor(core)
  }

  close(): void {
    this.unwatch()
    this.feed.close()
    this.supervisor.close()
  }

  /** Spawn on behalf of `conn`, resolving its pane anchor from its own entry. */
  private async handleSpawn(conn: Conn, msg: Extract<ClientMessage, { t: 'spawn' }>): Promise<void> {
    // An unregistered connection is the human at the CLI (§6.4) — they spawn
    // without being a session, and the socket is 0600, so reaching it at all
    // already means being the user. They hold no registry entry and therefore no
    // anchor, which §5.4 resolves as the new-window fallback rather than an error.
    const requestedBy = this.core.registry.nameOf(conn) ?? HUMAN
    const requester = this.core.registry.entryFor(conn)
    const anchor = this.core.registry.anchorFor(conn)
    const cwd = msg.cwd ?? this.core.registry.cwdFor(conn)
    const outcome = await this.supervisor.spawn({
      name: msg.name,
      profile: msg.profile,
      brief: msg.brief,
      requestedBy,
      // The requester's cwd, not the broker's. The broker is autostarted by
      // whichever client happened to connect first, so ITS cwd is an arbitrary
      // repo — spawning without this put an agent in an unrelated checkout.
      ...(cwd === undefined ? {} : { cwd }),
      ...(msg.isolation === undefined ? {} : { isolation: msg.isolation }),
      ...(msg.surface === undefined ? {} : { surface: msg.surface }),
      ...(msg.tags === undefined ? {} : { tags: msg.tags }),
      ...(msg.subscriptions === undefined ? {} : { subscriptions: msg.subscriptions }),
      ...(requester?.agentId === undefined ? {} : { parentAgentId: requester.agentId }),
      ...(anchor === undefined ? {} : { anchor }),
    })
    // Auto-subscribe the requester to its own spawn's lifecycle, so it learns
    // when the agent actually attaches without having to name it or poll
    // agent_list. Provenance rather than naming: the selector stays correct as
    // this connection spawns more agents later, with no rule to repoint.
    if (outcome.ok && outcome.name !== undefined) {
      this.core.registry.recordSpawn(conn, outcome.name)
      this.core.registry.subscribe(conn, [
        { selector: { spawnedBy: 'self' }, kinds: ['agent_attached', 'agent_exited'] },
      ])
    }
    reply(conn, {
      t: 'spawn_result',
      ok: outcome.ok,
      ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
      ...(outcome.name === undefined ? {} : { name: outcome.name }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
      ...(outcome.disallowedTools === undefined ? {} : { disallowedTools: outcome.disallowedTools }),
    })
  }

  /**
   * Teleport on behalf of `conn`, resolving WHO from its own registry entry.
   *
   * Every field the supervisor acts on — the identity to retire, the pid to
   * signal, the pane to reopen in, the tags and subscriptions to carry — is read
   * from the requester's own connection. The wire message carries none of them,
   * so there is no version of this call that ends someone else's session.
   */
  private async handleTeleport(conn: Conn, msg: Extract<ClientMessage, { t: 'teleport' }>): Promise<void> {
    const { registry } = this.core
    const entry = registry.entryFor(conn)
    if (entry?.agentId === undefined) {
      return reply(conn, {
        t: 'teleport_result',
        ok: false,
        reason:
          'teleport needs a durable identity, and this connection has none. Call chat_register ' +
          'first; if you already have, the broker could not read this session id from the ' +
          'environment, which an older MCP server does not send.',
      })
    }
    const outcome = await this.supervisor.teleport({
      subject: {
        agentId: entry.agentId,
        name: entry.name,
        cwd: registry.cwdFor(conn) ?? process.cwd(),
        tags: registry.tagsOf(conn),
        subscriptions: registry.subscriptionsOf(conn),
        ...(entry.hostPid === undefined ? {} : { hostPid: entry.hostPid }),
        ...(registry.anchorFor(conn) === undefined ? {} : { anchor: registry.anchorFor(conn) as string }),
      },
      handoff: msg.handoff,
      ...(msg.model === undefined ? {} : { model: msg.model }),
    })
    reply(conn, {
      t: 'teleport_result',
      ok: outcome.ok,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.name === undefined ? {} : { name: outcome.name }),
      ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
      ...(outcome.countdownMs === undefined ? {} : { countdownMs: outcome.countdownMs }),
      ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
    })
  }

  /**
   * True only for a connection with no registration — the human at the CLI, on
   * the theory that reaching a 0600 socket at all already means being the OS
   * account's owner.
   *
   * THIS IS A WEAKER GUARANTEE THAN THE FRAMES BUILT ON IT CLAIM. It stops a
   * session using ITS OWN registered connection to act with the human's
   * authority. It does NOT stop a process that opens a SECOND, unregistered
   * connection, or shells out to the `agent-chat` CLI, or writes raw bytes to
   * the socket with `nc` — none of those register, so all pass this check.
   * Verified empirically (CC-22 adversarial review, 2026-07-30): a `Bash`-
   * capable spawned agent self-approved its own endorsement three ways — a CLI
   * subprocess, a second in-process socket, and a bare `nc` pipe — because a
   * Unix socket carries no peer credentials for Node to check (`net.Socket`
   * exposes no pid/uid; `remoteAddress` is `undefined` on AF_UNIX). On this
   * machine every agent already runs under the human's own OS account, which
   * `agent-teams.md` §11.4 names as the actual trust boundary: "these controls
   * stop a confused agent, not an adversarial one." This check is exactly that
   * kind of control — real defense against an agent using its own established
   * session to act as the human, not a guarantee against a deliberately
   * adversarial co-resident process. See `profiles.ts` for the other half:
   * denying the builtin profiles' own `Bash` the ability to invoke these CLI
   * verbs at all, which is what actually stops the common case.
   */
  private isHuman(conn: Conn): boolean {
    return this.core.registry.nameOf(conn) === undefined
  }

  /** Record that a session reached for an action only the human may take. */
  private refuseToSession(conn: Conn, action: string): void {
    const name = this.core.registry.nameOf(conn) ?? '?'
    this.core.append({ kind: 'verdict_refused', actor: name, body: `a session tried to ${action}` })
  }

  /**
   * The countdown's abort, and the one place a check stands in for a structural
   * defence — deliberately, because a human at the CLI and an agent reach the
   * broker over the same socket, and the human's veto has to be reachable.
   *
   * A REGISTERED connection is a session, and no session may cancel a shutdown
   * (its own or anyone's): a descendant suppressing its predecessor's veto would
   * make the human's 30 seconds a formality. What is left is the human at the
   * CLI. No MCP tool exposes this frame. See `isHuman` for what this check does
   * and does not guarantee.
   */
  private handleTeleportAbort(conn: Conn, name: string): void {
    if (!this.isHuman(conn)) {
      this.refuseToSession(conn, 'cancel a teleport countdown')
      return reply(conn, {
        t: 'teleport_result',
        ok: false,
        reason: 'aborting a teleport is the human’s call; a session cannot cancel a countdown',
      })
    }
    const result = this.supervisor.abortTeleport(name)
    reply(conn, {
      t: 'teleport_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.ok ? { name } : {}),
    })
  }

  /**
   * Say out loud when a client is running a different build from the broker.
   *
   * CC-36: a session resolves its agent-chat entry through its own launcher, and
   * that need not be the entry the broker is running. The failure is invisible
   * from BOTH sides — the client registers normally, appears healthy on the
   * roster and answers messages, and only its TOOL LIST is stale. Two live
   * agents reported not having a tool the broker had shipped, and nothing said
   * the builds disagreed; it read as a feature defect for most of an hour.
   *
   * A notice rather than a refusal, because a mismatch is usually harmless — a
   * session started before a rebuild is running old code and working fine. What
   * is not acceptable is that it be SILENT.
   */
  private noteBuildMismatch(name: string, build: string | undefined): void {
    const ours = cliEntry()
    if (build === undefined || build === ours) return
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: HUMAN,
      body:
        `${name} is running a different agent-chat build from the broker. Its tools come from ` +
        `${build}; the broker is ${ours}. Tools added since that build will be missing from ` +
        `${name} even though it registered normally — restart it, or point its launcher at the ` +
        'same checkout.',
    })
    logEvent('build_mismatch', { name, client: build, broker: ours })
  }

  /**
   * Put a returning session back on the bus under the name it already held.
   *
   * The name comes from the LOG, never from the request — `bySession` matches
   * adopted identities only, so this cannot reach a spawned agent's name by
   * quoting its session id (the hole `BrokerCore.claimable` closes for agent
   * ids). A session with nothing to reclaim gets ok:false and carries on to the
   * ordinary `chat_register` path.
   */
  private handleReadopt(conn: Conn, msg: Extract<ClientMessage, { t: 'readopt' }>): void {
    const known = this.core.agents.bySession(msg.sessionId)
    if (known === undefined || known.name === '')
      return reply(conn, {
        t: 'register_result',
        ok: false,
        reason: 'no previous registration for this session',
      })
    // Already here: a live connection under this name means nothing was lost, and
    // re-registering would evict a healthy peer to fix a problem it does not have.
    if (this.core.registry.connFor(known.name) !== undefined)
      return reply(conn, { t: 'register_result', ok: false, reason: `${known.name} is already connected` })

    const result = this.core.register(conn, {
      t: 'register',
      name: known.name,
      workingOn: known.brief === '' ? 'reconnected after its MCP server was replaced' : known.brief,
      cwd: msg.cwd,
      pid: msg.pid,
      sessionId: msg.sessionId,
      ...(msg.hostPid === undefined ? {} : { hostPid: msg.hostPid }),
      ...(msg.termSessionId === undefined ? {} : { termSessionId: msg.termSessionId }),
      ...(msg.build === undefined ? {} : { build: msg.build }),
    })
    if (result.ok) logEvent('readopted', { name: known.name, sessionId: msg.sessionId })
    reply(conn, { t: 'register_result', ...result, ...(result.ok ? { name: known.name } : {}) })
  }

  /**
   * Pull a named headless agent into a terminal.
   *
   * The one field the request carries is WHO to surface. Everything about WHERE
   * it lands still comes from the requester's own connection: an anchored session
   * gets the agent beside it in the same window, and a background agent surfacing
   * itself has no anchor and opens its own window. Neither can be asked for.
   */
  private async handleSurface(conn: Conn, name: string): Promise<void> {
    const anchor = this.core.registry.anchorFor(conn)
    const outcome = await this.supervisor.switchSurface({
      name,
      to: 'interactive',
      requestedBy: this.core.registry.nameOf(conn) ?? HUMAN,
      ...(anchor === undefined ? {} : { anchor }),
    })
    replySwitch(conn, outcome)
  }

  /** Go headless. The subject is the caller, resolved here and nowhere else. */
  private async handleBackground(conn: Conn): Promise<void> {
    const entry = this.core.registry.entryFor(conn)
    if (entry?.agentId === undefined) {
      return replySwitch(conn, {
        ok: false,
        reason:
          'going headless needs a durable identity, and this connection has none. Call ' +
          'chat_register first.',
      })
    }
    const outcome = await this.supervisor.switchSurface({
      name: entry.name,
      to: 'headless',
      requestedBy: entry.name,
      ...(entry.hostPid === undefined ? {} : { hostPid: entry.hostPid }),
    })
    replySwitch(conn, outcome)
  }

  private handleRoute(
    conn: Conn,
    result: RouteResult<Conn>,
    kind: 'message' | 'broadcast',
    to: string,
  ): void {
    const { core } = this
    const from = core.registry.nameOf(conn) ?? '?'
    logEvent('route', {
      kind,
      msgId: result.msgId,
      from,
      to,
      delivered: result.ok,
      recipients: result.recipients,
    })

    for (const delivery of result.deliveries) {
      // One row per recipient so a session's inbox is a plain query on `target`.
      core.append({
        kind,
        actor: from,
        target: core.registry.nameOf(delivery.conn) ?? '?',
        msgId: delivery.message.msgId,
        ...(delivery.message.inReplyTo ? { ref: delivery.message.inReplyTo } : {}),
        body: delivery.message.text,
      })
      // Held deliveries are logged above and simply not pushed. The inbox is a
      // query over the log, so chat_inbox still returns them. Two independent
      // reasons to hold: the sender is over budget (whole route) or this one
      // recipient is in do-not-disturb.
      if (!result.suppressLive && delivery.live) deliver(delivery.conn, delivery.message)
    }
    if (!result.ok) {
      core.append({ kind: 'route_failed', actor: from, target: to, body: result.reason ?? 'unknown' })
    }
    if (result.escalate) this.escalateThread(result.escalate)

    reply(conn, {
      t: 'send_result',
      ok: result.ok,
      recipients: result.recipients,
      ...(result.msgId === undefined ? {} : { msgId: result.msgId }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.suppressLive || (result.deliveries.length > 0 && result.deliveries.every(d => !d.live))
        ? { held: true }
        : {}),
    })
  }

  /**
   * A broken thread is the one case where neither participant can raise the alarm:
   * the sender was refused and the recipient never heard anything. So it goes to the
   * human queue, which is the only party outside the loop.
   */
  private escalateThread(escalate: Escalation): void {
    const body =
      `${escalate.summary} Neither has been told anything the other can see; ` +
      'if the exchange was worthwhile, answer one of them.'
    const { msgId } = this.core.append({ kind: 'notice', actor: escalate.from, target: HUMAN, body })
    logEvent('exchange_breaker', {
      msgId,
      kind: escalate.kind,
      from: escalate.from,
      to: escalate.to,
      value: escalate.value,
    })
  }

  /** Messages to the human are logged, never delivered — nothing holds that socket. */
  private enqueueForHuman(conn: Conn, kind: 'message' | 'question' | 'notice', text: string): void {
    const { core } = this
    const from = core.registry.nameOf(conn)
    if (!from) return reply(conn, { t: 'send_result', ok: false, recipients: [], reason: 'not registered' })

    if (kind === 'question' && core.events.openCount(from, 'question') >= MAX_OPEN_QUESTIONS) {
      const reason = `you already have ${MAX_OPEN_QUESTIONS} unanswered questions; resolve one before asking again`
      return reply(conn, { t: 'send_result', ok: false, recipients: [], reason })
    }

    const { msgId } = core.append({ kind, actor: from, target: HUMAN, body: text })
    logEvent('route', { kind, msgId, from, to: HUMAN, delivered: true, recipients: [HUMAN] })
    reply(conn, { t: 'send_result', ok: true, msgId, recipients: [HUMAN] })
  }

  /**
   * Store a composed message for the human to read, and deliver NOTHING.
   *
   * The recipient is recorded now and read back from the log at approval time,
   * so the human's decision is bound to one body and one addressee together.
   */
  private handleEndorseRequest(conn: Conn, msg: Extract<ClientMessage, { t: 'endorse' }>): void {
    const { core } = this
    const from = core.registry.nameOf(conn)
    const refuse = (reason: string): void =>
      reply(conn, { t: 'send_result', ok: false, recipients: [], reason })
    if (!from) return refuse('not registered')
    // Endorsing a message to the human, or to yourself, is a request for a
    // signature on nothing: the value is entirely in what a THIRD party can tell
    // about where the authority came from.
    if (msg.to === HUMAN || msg.to === from)
      return refuse('an endorsement is relayed to a peer; your human is the one approving it')
    // The human is shown "would be delivered to X" and decides based on that
    // name. Refusing an unknown name here at least closes the case an adversarial
    // review found live: approving a request for a name nobody holds yet, which
    // then gets delivered to whoever happens to register it later. This does NOT
    // close the narrower race where the recipient changes identity between this
    // check and the human's eventual approval — that would need the approval
    // bound to an agentId rather than a name, which nothing else on this bus does
    // either (accepted, tracked separately).
    if (core.registry.connFor(msg.to) === undefined)
      return refuse(`no session named "${msg.to}" is currently connected`)
    if (core.events.openCount(from, 'endorse_request') >= MAX_OPEN_ENDORSEMENTS)
      return refuse(
        `you already have ${MAX_OPEN_ENDORSEMENTS} messages waiting for endorsement; ` +
          'let those be read before composing another',
      )

    const { msgId } = core.append({
      kind: 'endorse_request',
      actor: from,
      target: HUMAN,
      body: msg.text,
      meta: { recipient: msg.to },
    })
    logEvent('endorse_request', { msgId, from, to: msg.to })
    reply(conn, { t: 'send_result', ok: true, msgId, recipients: [HUMAN] })
  }

  /**
   * The human answering a queue item. CC-22's adversarial review found this had
   * NO sender check at all: any REGISTERED session could answer any OTHER
   * session's question and have it delivered as `from: HUMAN` — the single
   * cheapest forgery found, since it needs nothing but a frame on a connection
   * the caller already legitimately holds. No MCP tool exposes `answer`, so a
   * model reaches this only by talking to the socket directly; see `isHuman`.
   */
  private handleAnswer(conn: Conn, msgId: string, text: string): void {
    if (!this.isHuman(conn)) {
      this.refuseToSession(conn, 'answer a queue item')
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason: 'answering is the human’s call; a session cannot answer on the human’s behalf',
      })
    }
    const result = this.core.answer(msgId, text)
    reply(conn, {
      t: 'answer_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
  }

  /**
   * Close a queue item without answering it. Unlike `answer`, the item's own
   * AUTHOR may withdraw its own request — declining someone else's is still
   * human-only. CC-22's adversarial review found neither check present: any
   * registered session could silently dismiss any other session's pending item,
   * including one still waiting on human review.
   */
  private handleDismiss(conn: Conn, msgId: string): void {
    const author = this.core.events.authorOf(msgId)
    const caller = this.core.registry.nameOf(conn)
    if (!this.isHuman(conn) && caller !== author) {
      this.refuseToSession(conn, 'dismiss another session’s queue item')
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason: 'dismissing someone else’s item is the human’s call; a session may withdraw its own',
      })
    }
    const result = this.core.dismiss(msgId)
    reply(conn, {
      t: 'answer_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
  }

  /**
   * The human's approval, and the second half of what makes the marker
   * unforgeable AGAINST A SESSION USING ITS OWN CONNECTION — the first being
   * that no message shape carries the field itself. See `isHuman` for what this
   * check does and does not guarantee against a more determined bypass.
   */
  private handleEndorseApprove(conn: Conn, msgId: string): void {
    if (!this.isHuman(conn)) {
      this.refuseToSession(conn, 'endorse a message')
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason: 'endorsing is the human’s call; a session cannot endorse its own message or a peer’s',
      })
    }
    const result = this.core.endorse(msgId)
    reply(conn, {
      t: 'answer_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
  }

  /**
   * The human has no registration to route from, so this bypasses the ordinary
   * registry sender check on `send` — which is exactly why it needs its OWN
   * check instead of none at all. CC-22's adversarial review found this had
   * NONE: any connection, registered or not, could forge `from: HUMAN` AND
   * override do-not-disturb, with no CLI or endorsement flow involved. See
   * `isHuman` for what the fix below does and does not guarantee.
   */
  private handleHumanSend(conn: Conn, to: string, text: string): void {
    if (!this.isHuman(conn)) {
      this.refuseToSession(conn, 'send a message as the human')
      return reply(conn, {
        t: 'send_result',
        ok: false,
        recipients: [],
        reason: 'sending as the human is the human’s call; a session cannot speak with that authority',
      })
    }
    const { core } = this
    const target = core.registry.connFor(to)
    const msgId = newMsgId()
    if (!target) {
      core.append({ kind: 'route_failed', actor: HUMAN, target: to, body: 'no active session' })
      logEvent('route', { kind: 'message', msgId, from: HUMAN, to, delivered: false, recipients: [] })
      return reply(conn, {
        t: 'send_result',
        ok: false,
        recipients: [],
        reason: `no active session named "${to}"`,
      })
    }
    core.append({ kind: 'message', actor: HUMAN, target: to, msgId, body: text })
    // The human overrides do-not-disturb and no agent can. Scarcity has to be
    // structural: if any peer could mark a message urgent, every message would be
    // urgent within a day. There is simply no parameter for it on the agent path.
    deliver(target, { msgId, from: HUMAN, text, at: Date.now() })
    logEvent('route', { kind: 'message', msgId, from: HUMAN, to, delivered: true, recipients: [to] })
    reply(conn, { t: 'send_result', ok: true, msgId, recipients: [to] })
  }

  /**
   * A permission dialog opened in this session. Observed only: we never send a
   * verdict. Because `request_id` is never rendered in the terminal dialog, a
   * channel server is the only thing on the machine that can enumerate these.
   */
  private handleApproval(conn: Conn, msg: Extract<ClientMessage, { t: 'approval' }>): void {
    const { core } = this
    const from = core.registry.nameOf(conn)
    if (!from) return
    core.registry.setAwaitingApproval(conn, true)

    const { msgId } = core.append({
      kind: 'approval_request',
      actor: from,
      target: HUMAN,
      body: `${msg.toolName}: ${msg.description}`,
      meta: { request_id: msg.requestId, tool_name: msg.toolName, input_preview: msg.inputPreview },
    })
    logEvent('approval_request', { msgId, from, requestId: msg.requestId, tool: msg.toolName })
  }

  handleMessage(conn: Conn, msg: ClientMessage): void {
    const { core } = this
    core.registry.touch(conn)
    // A session blocked on a dialog cannot call tools, so anything else it sends
    // proves the dialog closed — the only unblock signal Claude Code gives us.
    if (msg.t !== 'approval' && core.registry.isAwaitingApproval(conn))
      core.registry.setAwaitingApproval(conn, false)
    switch (msg.t) {
      case 'register': {
        // Closing the displaced socket is what makes a takeover final: leaving it
        // open would let the predecessor keep writing under a name it no longer
        // holds. `end` rather than `destroy` so the fatal frame is flushed first
        // — the predecessor has to learn why, or it just reconnects and takes the
        // name back.
        const result = core.register(conn, msg, stale =>
          stale.end(encode({ t: 'error', reason: `superseded by a resume of "${msg.name}"`, fatal: true })),
        )
        if (result.ok) this.noteBuildMismatch(msg.name, msg.build)
        return reply(conn, { t: 'register_result', ...result })
      }
      case 'readopt':
        return this.handleReadopt(conn, msg)
      case 'status':
        return reply(conn, {
          t: 'status_result',
          ok: core.registry.setStatus(conn, msg.status, msg.workingOn, msg.dnd),
        })
      case 'list':
        return reply(conn, { t: 'list_result', sessions: core.registry.list() })
      case 'subscribe':
        return reply(conn, { t: 'subscribe_result', ...core.registry.subscribe(conn, msg.subscriptions) })
      case 'unsubscribe':
        return reply(conn, { t: 'subscribe_result', ...core.registry.unsubscribe(conn, msg.selector) })
      case 'send':
        if (msg.to === HUMAN) return this.enqueueForHuman(conn, 'message', msg.text)
        return this.handleRoute(
          conn,
          core.registry.send(conn, msg.to, msg.text, msg.inReplyTo),
          'message',
          msg.to,
        )
      case 'broadcast':
        return this.handleRoute(conn, core.registry.broadcast(conn, msg.text), 'broadcast', '*')
      case 'ask':
        return this.enqueueForHuman(conn, 'question', msg.text)
      case 'notify':
        return this.enqueueForHuman(conn, 'notice', msg.text)
      case 'endorse':
        return this.handleEndorseRequest(conn, msg)
      case 'endorse_approve':
        return this.handleEndorseApprove(conn, msg.msgId)
      case 'inbox': {
        const name = core.registry.nameOf(conn)
        return reply(conn, { t: 'inbox_result', messages: name ? core.events.inboxFor(name, msg.limit) : [] })
      }
      case 'queue':
        return reply(conn, { t: 'queue_result', items: core.events.humanQueue() })
      case 'answer':
        return this.handleAnswer(conn, msg.msgId, msg.text)
      case 'dismiss':
        return this.handleDismiss(conn, msg.msgId)
      case 'history':
        return reply(conn, { t: 'history_result', items: core.events.history(msg.limit) })
      case 'activity': {
        // Deliberately no deliver() anywhere on this path: reading a peer must
        // cost that peer nothing, or observing and interrupting stay the same act.
        const session = core.registry.list().find(s => s.name === msg.name)
        return reply(conn, {
          t: 'activity_result',
          ...(session ? { session } : {}),
          events: core.events.activityFor(msg.name, msg.limit),
        })
      }
      case 'human_send':
        return this.handleHumanSend(conn, msg.to, msg.text)
      case 'approval':
        return this.handleApproval(conn, msg)
      case 'spawn':
        void this.handleSpawn(conn, msg)
        return
      case 'agents':
        return reply(conn, {
          t: 'agents_result',
          agents: core.agents.roster({ includeRetired: msg.includeRetired ?? false }),
        })
      case 'teleport':
        void this.handleTeleport(conn, msg)
        return
      case 'teleport_abort':
        return this.handleTeleportAbort(conn, msg.name)
      case 'surface':
        void this.handleSurface(conn, msg.name)
        return
      case 'background':
        void this.handleBackground(conn)
        return
      case 'retire':
        void this.supervisor.retire(msg.name).then(result =>
          reply(conn, {
            t: 'spawn_result',
            ok: result.ok,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          }),
        )
        return
    }
  }

  onConnection(conn: Conn): void {
    const { core } = this
    const read = lineReader<ClientMessage>(
      msg => this.handleMessage(conn, msg),
      err => logEvent('bad_message', { error: err.message }),
    )
    conn.on('data', read)

    const drop = (): void => core.drop(conn)
    conn.on('close', drop)
    conn.on('error', drop)
  }
}

export async function startBroker(): Promise<net.Server | null> {
  const sock = socketPath()
  fs.mkdirSync(home(), { recursive: true })

  // Probe the socket BEFORE touching any other resource. This is the single
  // instance guard, and it has to run first so two racing auto-starts can never
  // both get as far as binding a port.
  if (await probeSocket(sock)) {
    logEvent('broker_exit', { reason: 'another broker is already listening' })
    return null
  }
  if (fs.existsSync(sock)) fs.unlinkSync(sock)

  const core = new BrokerCore(deliver)
  const socketServer = new SocketServer(core)
  const server = net.createServer(conn => socketServer.onConnection(conn))
  server.on('error', err => logEvent('broker_error', { error: String(err) }))

  await new Promise<void>(resolve => server.listen(sock, resolve))
  fs.chmodSync(sock, 0o600) // this user only; the trust boundary is the OS account
  logEvent('broker_started', { pid: process.pid, sock })

  // Written only after the socket is bound and serving, so their presence never
  // implies more than is true. `port` stays null until the HTTP layer exists and
  // reports what it actually got — the bind is best-effort, and recording an
  // intended port as though it were a bound one is how a status command starts
  // lying.
  writePidFile()
  writeMeta({ port: null, version: VERSION, started: Date.now(), pid: process.pid })

  /**
   * `tidy` is false for exactly one caller: the watchdog, when the socket at our
   * path now belongs to a DIFFERENT broker. Unlinking then would take out a live
   * broker's socket on the way out, and removing the state files would delete
   * the pid and meta it had just written — turning our own orphaning into an
   * outage for whoever replaced us.
   */
  const shutdown = (tidy = true): void => {
    logEvent('broker_stopping', { pid: process.pid })
    stopWatching()
    server.close()
    socketServer.close()
    core.close()
    if (tidy) {
      if (fs.existsSync(sock)) fs.unlinkSync(sock)
      removeStateFiles()
    }
    process.exit(0)
  }

  // A broker whose socket has been unlinked is unreachable, not degraded: no
  // client can find it and nothing will ever end it. See `watchSocket`.
  const stopWatching = watchSocket({
    path: sock,
    owner: readPidFile,
    onLost: reason => {
      logEvent('broker_exit', { reason, pid: process.pid })
      shutdown(!fs.existsSync(sock))
    },
  })

  process.on('SIGINT', () => shutdown())
  process.on('SIGTERM', () => shutdown())
  return server
}
