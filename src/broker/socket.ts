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
import { home, socketPath } from '../paths.js'
import { logEvent } from './log.js'
import { newMsgId } from './event-log.js'
import { type Escalation, type RouteResult } from './registry.js'
import { BrokerCore, type Conn } from './core.js'
import { Supervisor } from '../agents/supervisor.js'
import { SystemEventFeed } from './subscriptions.js'
import { probeSocket, removeStateFiles, writeMeta, writePidFile } from './lifecycle.js'
import { VERSION } from './version.js'

const MAX_OPEN_QUESTIONS = 3

const reply = (conn: Conn, message: ServerMessage): void => {
  conn.write(encode(message))
}

const deliver = (conn: Conn, message: DeliveredMessage): void => {
  reply(conn, { t: 'deliver', message })
}

/**
 * The socket transport. Everything here is about turning bytes into `core`
 * calls and results back into bytes; all state and every write to the log lives
 * in `BrokerCore`.
 */
class SocketServer {
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
    reply(conn, {
      t: 'spawn_result',
      ok: outcome.ok,
      ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
      ...(outcome.name === undefined ? {} : { name: outcome.name }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
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
   * The countdown's abort, and the one place a check stands in for a structural
   * defence — deliberately, because a human at the CLI and an agent reach the
   * broker over the same socket, and the human's veto has to be reachable.
   *
   * A REGISTERED connection is a session, and no session may cancel a shutdown
   * (its own or anyone's): a descendant suppressing its predecessor's veto would
   * make the human's 30 seconds a formality. What is left is the human at the
   * CLI, who holds no registration and could already retire or kill anything on
   * a 0600 socket. No MCP tool exposes this frame.
   */
  private handleTeleportAbort(conn: Conn, name: string): void {
    if (this.core.registry.nameOf(conn) !== undefined) {
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

    if (kind === 'question' && core.events.openQuestionCount(from) >= MAX_OPEN_QUESTIONS) {
      const reason = `you already have ${MAX_OPEN_QUESTIONS} unanswered questions; resolve one before asking again`
      return reply(conn, { t: 'send_result', ok: false, recipients: [], reason })
    }

    const { msgId } = core.append({ kind, actor: from, target: HUMAN, body: text })
    logEvent('route', { kind, msgId, from, to: HUMAN, delivered: true, recipients: [HUMAN] })
    reply(conn, { t: 'send_result', ok: true, msgId, recipients: [HUMAN] })
  }

  /** The human has no registration to route from, so this bypasses the registry sender check. */
  private handleHumanSend(conn: Conn, to: string, text: string): void {
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
        return reply(conn, { t: 'register_result', ...result })
      }
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
      case 'inbox': {
        const name = core.registry.nameOf(conn)
        return reply(conn, { t: 'inbox_result', messages: name ? core.events.inboxFor(name, msg.limit) : [] })
      }
      case 'queue':
        return reply(conn, { t: 'queue_result', items: core.events.humanQueue() })
      case 'answer': {
        const result = core.answer(msg.msgId, msg.text)
        return reply(conn, {
          t: 'answer_result',
          ok: result.ok,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        })
      }
      case 'dismiss': {
        const result = core.dismiss(msg.msgId)
        return reply(conn, {
          t: 'answer_result',
          ok: result.ok,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        })
      }
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

  const shutdown = (): void => {
    logEvent('broker_stopping', { pid: process.pid })
    server.close()
    socketServer.close()
    core.close()
    if (fs.existsSync(sock)) fs.unlinkSync(sock)
    removeStateFiles()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return server
}
