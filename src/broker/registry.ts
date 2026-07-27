import { randomUUID } from 'node:crypto'
import { RESERVED_NAMES, type DeliveredMessage, type SessionInfo, type SessionStatus } from '../protocol.js'

interface Entry {
  name: string
  workingOn: string
  cwd: string
  pid: number
  status: SessionStatus
  /** Set when Claude Code opened a permission dialog; cleared by any later activity. */
  awaitingApproval: boolean
  registeredAt: number
  lastSeen: number
}

/** A message the transport layer should write to `conn`. */
export interface Delivery<C> {
  conn: C
  message: DeliveredMessage
}

export interface RouteResult<C> {
  ok: boolean
  msgId?: string
  recipients: string[]
  reason?: string
  deliveries: Delivery<C>[]
}

const newMsgId = (): string => randomUUID().slice(0, 8)

/**
 * Registry and router, kept free of any I/O so routing decisions can be tested
 * directly. `C` is an opaque connection handle owned by the transport.
 */
export class Registry<C> {
  private readonly entries = new Map<C, Entry>()

  constructor(private readonly now: () => number = Date.now) {}

  private findByName(name: string): [C, Entry] | undefined {
    for (const pair of this.entries) if (pair[1].name === name) return pair
    return undefined
  }

  touch(conn: C): void {
    const entry = this.entries.get(conn)
    if (entry) entry.lastSeen = this.now()
  }

  /**
   * A name is a lease held by a live connection, so it can only be taken over
   * once the previous holder is gone. That covers restarts and /mcp reconnect.
   */
  register(
    conn: C,
    input: { name: string; workingOn: string; cwd: string; pid: number },
  ): { ok: boolean; reason?: string } {
    if (RESERVED_NAMES.has(input.name.toLowerCase()))
      return { ok: false, reason: `"${input.name}" is reserved and cannot be used as a session name` }

    const held = this.findByName(input.name)
    if (held && held[0] !== conn)
      return { ok: false, reason: `name "${input.name}" is held by another session` }

    const existing = this.entries.get(conn)
    this.entries.set(conn, {
      name: input.name,
      workingOn: input.workingOn,
      cwd: input.cwd,
      pid: input.pid,
      status: existing?.status ?? 'available',
      awaitingApproval: existing?.awaitingApproval ?? false,
      registeredAt: existing?.registeredAt ?? this.now(),
      lastSeen: this.now(),
    })
    return { ok: true }
  }

  setStatus(conn: C, status: SessionStatus, workingOn?: string): boolean {
    const entry = this.entries.get(conn)
    if (!entry) return false
    entry.status = status
    if (workingOn !== undefined) entry.workingOn = workingOn
    entry.lastSeen = this.now()
    return true
  }

  list(): SessionInfo[] {
    return [...this.entries.values()].map(e => ({
      name: e.name,
      workingOn: e.workingOn,
      cwd: e.cwd,
      status: e.awaitingApproval ? 'blocked' : e.status,
      idleMs: this.now() - e.lastSeen,
      registeredAt: e.registeredAt,
    }))
  }

  nameOf(conn: C): string | undefined {
    return this.entries.get(conn)?.name
  }

  /** The live connection for a name, if that session is currently up. */
  connFor(name: string): C | undefined {
    return this.findByName(name)?.[0]
  }

  /**
   * A permission dialog is the one case where blocked-ness is knowable rather
   * than self-reported: a session waiting on one cannot call tools, so the next
   * message from it is proof the dialog closed.
   */
  setAwaitingApproval(conn: C, awaiting: boolean): void {
    const entry = this.entries.get(conn)
    if (entry) entry.awaitingApproval = awaiting
  }

  isAwaitingApproval(conn: C): boolean {
    return this.entries.get(conn)?.awaitingApproval ?? false
  }

  entryFor(conn: C): { workingOn: string; status: SessionStatus } | undefined {
    const entry = this.entries.get(conn)
    return entry ? { workingOn: entry.workingOn, status: entry.status } : undefined
  }

  private build(from: string, text: string, extra: Partial<DeliveredMessage> = {}): DeliveredMessage {
    return { msgId: newMsgId(), from, text, at: this.now(), ...extra }
  }

  /** Routes to exactly one session, or to none if the name isn't registered. */
  send(conn: C, to: string, text: string, inReplyTo?: string): RouteResult<C> {
    const sender = this.entries.get(conn)
    if (!sender) return { ok: false, recipients: [], reason: 'not registered', deliveries: [] }

    const target = this.findByName(to)
    if (!target)
      return { ok: false, recipients: [], reason: `no active session named "${to}"`, deliveries: [] }
    if (target[0] === conn)
      return { ok: false, recipients: [], reason: 'cannot send to yourself', deliveries: [] }

    const message = this.build(sender.name, text, inReplyTo === undefined ? {} : { inReplyTo })
    return { ok: true, msgId: message.msgId, recipients: [to], deliveries: [{ conn: target[0], message }] }
  }

  /** Routes to every registered session except the sender. */
  broadcast(conn: C, text: string): RouteResult<C> {
    const sender = this.entries.get(conn)
    if (!sender) return { ok: false, recipients: [], reason: 'not registered', deliveries: [] }

    const message = this.build(sender.name, text, { broadcast: true })
    const deliveries: Delivery<C>[] = []
    for (const target of this.entries.keys()) {
      if (target === conn) continue
      deliveries.push({ conn: target, message })
    }
    return {
      ok: true,
      msgId: message.msgId,
      recipients: deliveries.map(d => this.nameOf(d.conn) ?? '?'),
      deliveries,
    }
  }

  drop(conn: C): string | undefined {
    const name = this.entries.get(conn)?.name
    this.entries.delete(conn)
    return name
  }
}
