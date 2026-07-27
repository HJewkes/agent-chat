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
import { EventLog, newMsgId } from './event-log.js'
import { Registry, type RouteResult } from './registry.js'

type Conn = net.Socket

const MAX_OPEN_QUESTIONS = 3

const registry = new Registry<Conn>()
let events: EventLog

const reply = (conn: Conn, message: ServerMessage): void => {
  conn.write(encode(message))
}

const deliver = (conn: Conn, message: DeliveredMessage): void => {
  reply(conn, { t: 'deliver', message })
}

/** Live delivery to a named session if it happens to be connected. */
function deliverTo(name: string, message: DeliveredMessage): boolean {
  const target = registry.connFor(name)
  if (!target) return false
  deliver(target, message)
  return true
}

function handleRoute(conn: Conn, result: RouteResult<Conn>, kind: 'message' | 'broadcast', to: string): void {
  const from = registry.nameOf(conn) ?? '?'
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
    events.append({
      kind,
      actor: from,
      target: registry.nameOf(delivery.conn) ?? '?',
      msgId: delivery.message.msgId,
      ...(delivery.message.inReplyTo ? { ref: delivery.message.inReplyTo } : {}),
      body: delivery.message.text,
    })
    // Suppressed deliveries are logged above and simply not pushed. The inbox is
    // a query over the log, so chat_inbox still returns them.
    if (!result.suppressLive) deliver(delivery.conn, delivery.message)
  }
  if (!result.ok) {
    events.append({ kind: 'route_failed', actor: from, target: to, body: result.reason ?? 'unknown' })
  }
  if (result.escalate) escalateThread(result.escalate)

  reply(conn, {
    t: 'send_result',
    ok: result.ok,
    recipients: result.recipients,
    ...(result.msgId === undefined ? {} : { msgId: result.msgId }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.suppressLive ? { held: true } : {}),
  })
}

/**
 * A broken thread is the one case where neither participant can raise the alarm:
 * the sender was refused and the recipient never heard anything. So it goes to the
 * human queue, which is the only party outside the loop.
 */
function escalateThread(escalate: { from: string; to: string; depth: number }): void {
  const body =
    `${escalate.from} and ${escalate.to} reached reply depth ${escalate.depth} and were stopped. ` +
    'Neither has been told anything the other can see; if the exchange was worthwhile, ' +
    'answer one of them.'
  const { msgId } = events.append({ kind: 'notice', actor: escalate.from, target: HUMAN, body })
  logEvent('thread_breaker', { msgId, from: escalate.from, to: escalate.to, depth: escalate.depth })
}

/** Messages to the human are logged, never delivered — nothing holds that socket. */
function enqueueForHuman(conn: Conn, kind: 'message' | 'question' | 'notice', text: string): void {
  const from = registry.nameOf(conn)
  if (!from) return reply(conn, { t: 'send_result', ok: false, recipients: [], reason: 'not registered' })

  if (kind === 'question' && events.openQuestionCount(from) >= MAX_OPEN_QUESTIONS) {
    const reason = `you already have ${MAX_OPEN_QUESTIONS} unanswered questions; resolve one before asking again`
    return reply(conn, { t: 'send_result', ok: false, recipients: [], reason })
  }

  const { msgId } = events.append({ kind, actor: from, target: HUMAN, body: text })
  logEvent('route', { kind, msgId, from, to: HUMAN, delivered: true, recipients: [HUMAN] })
  reply(conn, { t: 'send_result', ok: true, msgId, recipients: [HUMAN] })
}

/** The human answering an item: logged, and pushed live if the asker is still up. */
function handleAnswer(conn: Conn, msgId: string, text: string): void {
  if (!events.isOpen(msgId)) {
    return reply(conn, { t: 'answer_result', ok: false, reason: `${msgId} is not an open item` })
  }
  const author = events.authorOf(msgId)
  if (!author) return reply(conn, { t: 'answer_result', ok: false, reason: `no item with id ${msgId}` })

  const message: DeliveredMessage = { msgId: newMsgId(), from: HUMAN, text, inReplyTo: msgId, at: Date.now() }
  events.append({
    kind: 'answer',
    actor: HUMAN,
    target: author,
    msgId: message.msgId,
    ref: msgId,
    body: text,
  })
  const live = deliverTo(author, message)
  logEvent('route', {
    kind: 'answer',
    msgId: message.msgId,
    from: HUMAN,
    to: author,
    delivered: live,
    ref: msgId,
  })
  reply(conn, {
    t: 'answer_result',
    ok: true,
    ...(live ? {} : { reason: `${author} is offline; queued in its inbox` }),
  })
}

/** The human has no registration to route from, so this bypasses the registry sender check. */
function handleHumanSend(conn: Conn, to: string, text: string): void {
  const target = registry.connFor(to)
  const msgId = newMsgId()
  if (!target) {
    events.append({ kind: 'route_failed', actor: HUMAN, target: to, body: 'no active session' })
    logEvent('route', { kind: 'message', msgId, from: HUMAN, to, delivered: false, recipients: [] })
    return reply(conn, {
      t: 'send_result',
      ok: false,
      recipients: [],
      reason: `no active session named "${to}"`,
    })
  }
  events.append({ kind: 'message', actor: HUMAN, target: to, msgId, body: text })
  deliver(target, { msgId, from: HUMAN, text, at: Date.now() })
  logEvent('route', { kind: 'message', msgId, from: HUMAN, to, delivered: true, recipients: [to] })
  reply(conn, { t: 'send_result', ok: true, msgId, recipients: [to] })
}

/**
 * A permission dialog opened in this session. Observed only: we never send a
 * verdict. Because `request_id` is never rendered in the terminal dialog, a
 * channel server is the only thing on the machine that can enumerate these.
 */
function handleApproval(conn: Conn, msg: Extract<ClientMessage, { t: 'approval' }>): void {
  const from = registry.nameOf(conn)
  if (!from) return
  registry.setAwaitingApproval(conn, true)

  const { msgId } = events.append({
    kind: 'approval_request',
    actor: from,
    target: HUMAN,
    body: `${msg.toolName}: ${msg.description}`,
    meta: { request_id: msg.requestId, tool_name: msg.toolName, input_preview: msg.inputPreview },
  })
  logEvent('approval_request', { msgId, from, requestId: msg.requestId, tool: msg.toolName })
}

function handleMessage(conn: Conn, msg: ClientMessage): void {
  registry.touch(conn)
  // A session blocked on a dialog cannot call tools, so anything else it sends
  // proves the dialog closed — the only unblock signal Claude Code gives us.
  if (msg.t !== 'approval' && registry.isAwaitingApproval(conn)) registry.setAwaitingApproval(conn, false)
  switch (msg.t) {
    case 'register': {
      const result = registry.register(conn, msg)
      if (result.ok)
        events.append({ kind: 'registered', actor: msg.name, body: msg.workingOn, meta: { cwd: msg.cwd } })
      logEvent(result.ok ? 'registered' : 'register_rejected', { name: msg.name, reason: result.reason })
      return reply(conn, { t: 'register_result', ...result })
    }
    case 'status':
      return reply(conn, { t: 'status_result', ok: registry.setStatus(conn, msg.status, msg.workingOn) })
    case 'list':
      return reply(conn, { t: 'list_result', sessions: registry.list() })
    case 'send':
      if (msg.to === HUMAN) return enqueueForHuman(conn, 'message', msg.text)
      return handleRoute(conn, registry.send(conn, msg.to, msg.text, msg.inReplyTo), 'message', msg.to)
    case 'broadcast':
      return handleRoute(conn, registry.broadcast(conn, msg.text), 'broadcast', '*')
    case 'ask':
      return enqueueForHuman(conn, 'question', msg.text)
    case 'notify':
      return enqueueForHuman(conn, 'notice', msg.text)
    case 'inbox': {
      const name = registry.nameOf(conn)
      return reply(conn, { t: 'inbox_result', messages: name ? events.inboxFor(name, msg.limit) : [] })
    }
    case 'queue':
      return reply(conn, { t: 'queue_result', items: events.humanQueue() })
    case 'answer':
      return handleAnswer(conn, msg.msgId, msg.text)
    case 'dismiss': {
      if (!events.isOpen(msg.msgId)) {
        return reply(conn, { t: 'answer_result', ok: false, reason: `${msg.msgId} is not an open item` })
      }
      events.append({ kind: 'resolution', actor: HUMAN, ref: msg.msgId, body: 'dismissed' })
      return reply(conn, { t: 'answer_result', ok: true })
    }
    case 'history':
      return reply(conn, { t: 'history_result', items: events.history(msg.limit) })
    case 'human_send':
      return handleHumanSend(conn, msg.to, msg.text)
    case 'approval':
      return handleApproval(conn, msg)
  }
}

function onConnection(conn: Conn): void {
  const read = lineReader<ClientMessage>(
    msg => handleMessage(conn, msg),
    err => logEvent('bad_message', { error: err.message }),
  )
  conn.on('data', read)

  const drop = (): void => {
    const entry = registry.entryFor(conn)
    const name = registry.drop(conn)
    if (!name) return
    logEvent('deregistered', { name, reason: 'connection closed' })
    events.append({
      kind: 'deregistered',
      actor: name,
      body: entry?.workingOn ?? '',
      meta: { status: entry?.status ?? '' },
    })
  }
  conn.on('close', drop)
  conn.on('error', drop)
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

  events = new EventLog()
  const server = net.createServer(onConnection)
  server.on('error', err => logEvent('broker_error', { error: String(err) }))

  await new Promise<void>(resolve => server.listen(sock, resolve))
  fs.chmodSync(sock, 0o600) // this user only; the trust boundary is the OS account
  logEvent('broker_started', { pid: process.pid, sock })

  const shutdown = (): void => {
    logEvent('broker_stopping', { pid: process.pid })
    server.close()
    events.close()
    if (fs.existsSync(sock)) fs.unlinkSync(sock)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return server
}
