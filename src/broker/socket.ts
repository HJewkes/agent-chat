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
  constructor(private readonly core: BrokerCore) {}

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
        const result = core.registry.register(conn, msg)
        if (result.ok)
          core.append({ kind: 'registered', actor: msg.name, body: msg.workingOn, meta: { cwd: msg.cwd } })
        logEvent(result.ok ? 'registered' : 'register_rejected', { name: msg.name, reason: result.reason })
        return reply(conn, { t: 'register_result', ...result })
      }
      case 'status':
        return reply(conn, {
          t: 'status_result',
          ok: core.registry.setStatus(conn, msg.status, msg.workingOn, msg.dnd),
        })
      case 'list':
        return reply(conn, { t: 'list_result', sessions: core.registry.list() })
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
    }
  }

  onConnection(conn: Conn): void {
    const { core } = this
    const read = lineReader<ClientMessage>(
      msg => this.handleMessage(conn, msg),
      err => logEvent('bad_message', { error: err.message }),
    )
    conn.on('data', read)

    const drop = (): void => {
      const entry = core.registry.entryFor(conn)
      const name = core.registry.drop(conn)
      if (!name) return
      logEvent('deregistered', { name, reason: 'connection closed' })
      core.append({
        kind: 'deregistered',
        actor: name,
        body: entry?.workingOn ?? '',
        meta: { status: entry?.status ?? '' },
      })
    }
    conn.on('close', drop)
    conn.on('error', drop)
  }
}

/** Distinguishes a live broker from a socket file left by a killed one. */
function probeExisting(sock: string): Promise<boolean> {
  return new Promise(resolve => {
    if (!fs.existsSync(sock)) return resolve(false)
    const probe = net.connect(sock)
    probe.on('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
  })
}

export async function startBroker(): Promise<net.Server | null> {
  const sock = socketPath()
  fs.mkdirSync(home(), { recursive: true })

  if (await probeExisting(sock)) {
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

  const shutdown = (): void => {
    logEvent('broker_stopping', { pid: process.pid })
    server.close()
    core.close()
    if (fs.existsSync(sock)) fs.unlinkSync(sock)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return server
}
