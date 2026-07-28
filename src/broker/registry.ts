import { randomUUID } from 'node:crypto'
import {
  RESERVED_NAMES,
  SUBSCRIBABLE_KINDS,
  type DeliveredMessage,
  type SessionInfo,
  type SessionStatus,
  type Subscription,
  type SubscriptionSelector,
} from '../protocol.js'

/**
 * Drop any kind that is not subscribable, wherever subscriptions enter.
 *
 * Enforced HERE, not only in the tool handler. The tool is one client of this
 * socket; a raw client on the same 0600 socket can send whatever it likes and was
 * previously stored verbatim, so `kinds: ['message']` was accepted with ok:true.
 * Nothing leaked, because the feed also gates on the row kind — but resting a
 * content-isolation property on a single check is how it stops being true after
 * an unrelated refactor.
 */
const sanitizeSubscriptions = (subscriptions: Subscription[]): Subscription[] =>
  subscriptions.map(sub => ({
    selector: sub.selector,
    kinds: sub.kinds.filter(kind => (SUBSCRIBABLE_KINDS as readonly string[]).includes(kind)),
  }))

/** Selectors are the identity of a subscription, which is what makes re-subscribing idempotent. */
const sameSelector = (a: SubscriptionSelector, b: SubscriptionSelector): boolean => {
  if ('all' in a || 'all' in b) return 'all' in a && 'all' in b
  if ('name' in a || 'name' in b) return 'name' in a && 'name' in b && a.name === b.name
  return a.tag === b.tag
}

interface Entry {
  name: string
  workingOn: string
  cwd: string
  pid: number
  /**
   * Set when this connection registered against a durable agent identity. The
   * registry stays ignorant of what an agent is — it only needs the id to tell a
   * resume takeover apart from a name collision, and to name the identity that
   * just went away when the socket drops.
   */
  agentId?: string
  /**
   * The requester's `ITERM_SESSION_ID`, used as the anchor for a visible spawn.
   *
   * Presence data, and deliberately so: the broker is started detached with
   * `stdio: 'ignore'` and has no terminal of its own, so the process that does
   * the spawning is structurally not the process that knows where to put a pane.
   * An anchor is a property of a live connection and is meaningless once that
   * connection is gone — which is exactly the lifetime an entry already has.
   * Storing it here also means a requester can only ever offer its own pane.
   */
  termSessionId?: string
  status: SessionStatus
  /** Set when Claude Code opened a permission dialog; cleared by any later activity. */
  awaitingApproval: boolean
  /**
   * Do not push to this session; log for its inbox instead. Orthogonal to status
   * on purpose — a session can be working and still want messages, or available
   * and want silence, so this is not a fourth SessionStatus.
   */
  dnd: boolean
  /** Many per session: a session is usually in more than one conversation. */
  tags: string[]
  /** Ephemeral like everything else here — re-declared on register, never stored. */
  subscriptions: Subscription[]
  registeredAt: number
  lastSeen: number
}

/**
 * A message the transport layer should record for `conn`. `live: false` means log
 * it to the inbox but do not push — the recipient is in do-not-disturb. Per
 * delivery rather than per route, because one broadcast can be live for some
 * recipients and held for others.
 */
export interface Delivery<C> {
  conn: C
  message: DeliveredMessage
  live: boolean
}

export interface RouteResult<C> {
  ok: boolean
  msgId?: string
  recipients: string[]
  reason?: string
  deliveries: Delivery<C>[]
  /**
   * Log the deliveries to recipients' inboxes but do not push them live. The
   * event log is the source of truth and the inbox is a query over it, so a
   * suppressed message survives even a broker restart — which is what makes
   * throttling lossless rather than lossy.
   */
  suppressLive?: boolean
  /** A stopped exchange the human should be told about, since neither peer will be. */
  escalate?: Escalation
}

/**
 * Depth asks how deep one conversation has gone; rate asks how fast two sessions
 * are talking regardless of threading. They catch different things and one
 * threshold cannot serve both, so the trip carries which measurement fired.
 */
export interface Escalation {
  from: string
  to: string
  kind: 'thread_depth' | 'exchange_rate'
  /** The measurement that tripped, for the routing log. */
  value: number
  /** One line for the human queue, who is the only party outside the exchange. */
  summary: string
}

/**
 * Thread depth at which peers get a visible nudge but the message still flows,
 * and the depth at which the broker stops relaying it at all.
 *
 * Both are deliberately far above anything observed. The longest real chain on
 * 2026-07-27 ran to depth 5 and every link corrected a genuine error, so a
 * breaker anywhere near that would destroy the exchanges most worth having.
 * A depth counter cannot distinguish convergence from two agents being polite
 * at each other; it can only catch the runaway case, so it is tuned to do only
 * that. Neither constant is validated against steady-state multi-session work.
 */
const THREAD_WARN_DEPTH = 10
const THREAD_MAX_DEPTH = 20

/** How many msgId -> depth entries to remember before evicting the oldest. */
const DEPTH_MEMORY = 2000

/**
 * Backstop for the evasion the depth breaker cannot see: depth resets the moment
 * a model opens a fresh thread instead of replying, and that is what a
 * well-intentioned model does — "this is a new topic" is a reasonable thought
 * mid-volley. Counting per ordered pair catches two sessions alternating across
 * many shallow threads, which burns the same tokens with none of the signal.
 *
 * The window is long on purpose. Every reply costs a model turn, so a legitimate
 * pair and a runaway one look alike over 60 seconds; they only separate when
 * sustained. 20 messages in one direction inside 10 minutes is one every 30
 * seconds, held up for the whole window. Not tuned to 2026-07-27, where the
 * busiest ordered pair managed roughly 6 messages in 40 minutes.
 */
const PAIR_WINDOW_MS = 10 * 60_000
const PAIR_MAX_MESSAGES = 20

/**
 * Broadcast budget, denominated in amplified bytes (payload x live recipients)
 * because fanout is the cost. On 2026-07-27 broadcasts were 3 of 17 messages but
 * 57% of all delivered bytes, so a message-count budget would have missed the
 * problem entirely. Directed messages are never throttled: broadcast is where
 * the abuse lives, and starving a targeted request would break real work.
 */
const BROADCAST_WINDOW_MS = 60_000
const BROADCAST_BUDGET_BYTES = 16_000

const newMsgId = (): string => randomUUID().slice(0, 8)

/**
 * Registry and router, kept free of any I/O so routing decisions can be tested
 * directly. `C` is an opaque connection handle owned by the transport.
 */
export class Registry<C> {
  private readonly entries = new Map<C, Entry>()
  /** msgId -> chain length, so a reply can find its parent's depth in O(1). */
  private readonly depths = new Map<string, number>()
  /** Sender name -> recent broadcast spend, pruned to the current window on read. */
  private readonly broadcastSpend = new Map<string, { at: number; bytes: number }[]>()
  /** "from -> to" -> send times, pruned on read. Ordered, so each way is its own budget. */
  private readonly pairSends = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Depth of a reply to `inReplyTo`: one past its parent, or 1 to start a thread. */
  private depthFor(inReplyTo?: string): number {
    if (inReplyTo === undefined) return 1
    return (this.depths.get(inReplyTo) ?? 0) + 1
  }

  private rememberDepth(msgId: string, depth: number): void {
    // Insertion-ordered, so the first key is the oldest. Bounded because a
    // long-lived broker would otherwise accumulate one entry per message ever.
    if (this.depths.size >= DEPTH_MEMORY) {
      const oldest = this.depths.keys().next()
      if (!oldest.done) this.depths.delete(oldest.value)
    }
    this.depths.set(msgId, depth)
  }

  /** Send times from one session to another, pruned to the current window in place. */
  private pairLedger(from: string, to: string): number[] {
    // NUL separator because nothing stops a session registering a name with a
    // space in it, and "a b" -> "c" must not collide with "a" -> "b c".
    const key = `${from}\u0000${to}`
    const cutoff = this.now() - PAIR_WINDOW_MS
    const kept = (this.pairSends.get(key) ?? []).filter(at => at > cutoff)
    this.pairSends.set(key, kept)
    return kept
  }

  /** This sender's broadcast spend, pruned to the current window in place. */
  private broadcastLedger(name: string): { at: number; bytes: number }[] {
    const cutoff = this.now() - BROADCAST_WINDOW_MS
    const kept = (this.broadcastSpend.get(name) ?? []).filter(s => s.at > cutoff)
    this.broadcastSpend.set(name, kept)
    return kept
  }

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
   *
   * One exception, and it exists for resume. When the incoming registration
   * carries the same `agentId` as the entry currently holding the name, this is
   * the same durable agent arriving in a new process — a takeover, not a
   * collision. Without it, a resumed agent racing its predecessor's `close`
   * handler fails with "held by another session", and the failure reads as a bug
   * in resume rather than the race it is. The evicted connection comes back so
   * the caller can record the detach and close the socket; identity checks are
   * the caller's job, since the registry does not know what an agent id means.
   */
  register(
    conn: C,
    input: {
      name: string
      workingOn: string
      cwd: string
      pid: number
      agentId?: string
      termSessionId?: string
      tags?: string[]
      subscriptions?: Subscription[]
    },
  ): { ok: boolean; reason?: string; evicted?: C } {
    if (RESERVED_NAMES.has(input.name.toLowerCase()))
      return { ok: false, reason: `"${input.name}" is reserved and cannot be used as a session name` }

    const held = this.findByName(input.name)
    let evicted: C | undefined
    if (held && held[0] !== conn) {
      const sameAgent = input.agentId !== undefined && held[1].agentId === input.agentId
      if (!sameAgent) return { ok: false, reason: `name "${input.name}" is held by another session` }
      evicted = held[0]
      this.entries.delete(evicted)
    }

    const existing = this.entries.get(conn)
    this.entries.set(conn, {
      name: input.name,
      workingOn: input.workingOn,
      cwd: input.cwd,
      pid: input.pid,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.termSessionId === undefined ? {} : { termSessionId: input.termSessionId }),
      // A re-register re-declares both, which is how a resumed agent gets its
      // subscriptions back without anything having persisted them.
      tags: input.tags ?? existing?.tags ?? [],
      subscriptions: input.subscriptions
        ? sanitizeSubscriptions(input.subscriptions)
        : (existing?.subscriptions ?? []),
      status: existing?.status ?? 'available',
      awaitingApproval: existing?.awaitingApproval ?? false,
      dnd: existing?.dnd ?? false,
      registeredAt: existing?.registeredAt ?? this.now(),
      lastSeen: this.now(),
    })
    return { ok: true, ...(evicted === undefined ? {} : { evicted }) }
  }

  setStatus(conn: C, status: SessionStatus, workingOn?: string, dnd?: boolean): boolean {
    const entry = this.entries.get(conn)
    if (!entry) return false
    entry.status = status
    if (workingOn !== undefined) entry.workingOn = workingOn
    if (dnd !== undefined) entry.dnd = dnd
    entry.lastSeen = this.now()
    return true
  }

  isDnd(name: string): boolean {
    return this.findByName(name)?.[1].dnd ?? false
  }

  list(): SessionInfo[] {
    return [...this.entries.values()].map(e => ({
      name: e.name,
      workingOn: e.workingOn,
      cwd: e.cwd,
      status: e.awaitingApproval ? 'blocked' : e.status,
      dnd: e.dnd,
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
   * The pane a spawn requested from `conn` should be anchored to.
   *
   * Read from the requester's OWN entry rather than taken from the request, so a
   * session cannot claim someone else's pane and land an agent in a window it
   * has nothing to do with.
   */
  anchorFor(conn: C): string | undefined {
    return this.entries.get(conn)?.termSessionId
  }

  /** Where the requester is working, for spawns that name no cwd of their own. */
  cwdFor(conn: C): string | undefined {
    return this.entries.get(conn)?.cwd
  }

  /**
   * Replace by selector rather than append, so a session re-declaring what it
   * wants converges instead of accumulating duplicates of the same rule.
   */
  subscribe(conn: C, subscriptions: Subscription[]): { ok: boolean; held: number; reason?: string } {
    const entry = this.entries.get(conn)
    if (!entry) return { ok: false, held: 0, reason: 'register before subscribing' }

    // Filtered HERE, not only in the tool handler. The tool is one client of this
    // socket; a raw client on the same 0600 socket can send whatever it likes, and
    // was previously stored verbatim — so `kinds: ['message']` was accepted with
    // ok:true. Nothing leaked, because the feed also gates on the row kind, but
    // resting a content-isolation property on a single check is how it stops
    // being true after an unrelated refactor.
    for (const wanted of sanitizeSubscriptions(subscriptions)) {
      const at = entry.subscriptions.findIndex(s => sameSelector(s.selector, wanted.selector))
      if (at === -1) entry.subscriptions.push(wanted)
      else entry.subscriptions[at] = wanted
    }
    // A subscription with no kinds is an unsubscribe by another name; dropping it
    // here means "subscribe to nothing" cannot leave a rule that matches nothing.
    entry.subscriptions = entry.subscriptions.filter(s => s.kinds.length > 0)
    return { ok: true, held: entry.subscriptions.length }
  }

  unsubscribe(conn: C, selector?: SubscriptionSelector): { ok: boolean; held: number } {
    const entry = this.entries.get(conn)
    if (!entry) return { ok: false, held: 0 }

    entry.subscriptions = selector ? entry.subscriptions.filter(s => !sameSelector(s.selector, selector)) : []
    return { ok: true, held: entry.subscriptions.length }
  }

  tagsOf(conn: C): string[] {
    return this.entries.get(conn)?.tags ?? []
  }

  /** Every session currently carrying a tag, for resolving a `tag` selector. */
  private namesWithTag(tag: string): Set<string> {
    const names = new Set<string>()
    for (const entry of this.entries.values()) if (entry.tags.includes(tag)) names.add(entry.name)
    return names
  }

  /**
   * Who should be pushed this event, and never the session it is about — being
   * told that you yourself just registered is pure noise.
   *
   * A `tag` selector matches on the SUBJECT's tags, not the subscriber's: "tell
   * me about the agent-teams agents" is a question about them, not about me.
   */
  subscribersFor(event: { kind: string; subject: string }): C[] {
    const matched: C[] = []
    for (const [conn, entry] of this.entries) {
      if (entry.name === event.subject) continue
      // Suppressed rather than queued: a system event is already durable in the
      // log, so `history` still shows it and nothing is lost by not pushing.
      if (entry.dnd) continue

      const wants = entry.subscriptions.some(sub => {
        if (!(sub.kinds as readonly string[]).includes(event.kind)) return false
        if ('all' in sub.selector) return true
        if ('name' in sub.selector) return sub.selector.name === event.subject
        return this.namesWithTag(sub.selector.tag).has(event.subject)
      })
      if (wants) matched.push(conn)
    }
    return matched
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

  entryFor(
    conn: C,
  ): { name: string; workingOn: string; status: SessionStatus; agentId?: string } | undefined {
    const entry = this.entries.get(conn)
    if (!entry) return undefined
    return {
      name: entry.name,
      workingOn: entry.workingOn,
      status: entry.status,
      ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
    }
  }

  private build(from: string, text: string, extra: Partial<DeliveredMessage> = {}): DeliveredMessage {
    const depth = this.depthFor(extra.inReplyTo)
    const msgId = newMsgId()
    this.rememberDepth(msgId, depth)
    return {
      msgId,
      from,
      text,
      at: this.now(),
      threadDepth: depth,
      ...(depth >= THREAD_WARN_DEPTH ? { threadHint: 'wrap_up' } : {}),
      ...extra,
    }
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

    // The breaker exists for the case nobody is watching: two agents that ignore
    // the depth stamps would otherwise ping-pong indefinitely, burning tokens in
    // both while the human sees only a routing log they are not tailing.
    const depth = this.depthFor(inReplyTo)
    if (depth >= THREAD_MAX_DEPTH) {
      return {
        ok: false,
        recipients: [],
        reason:
          `this reply would be depth ${depth}, past the limit of ${THREAD_MAX_DEPTH}. ` +
          'The thread has been escalated to the human queue. Do not start a fresh thread ' +
          'to continue it — wait for the human, who can see both sides.',
        deliveries: [],
        escalate: {
          from: sender.name,
          to,
          kind: 'thread_depth',
          value: depth,
          summary: `${sender.name} and ${to} reached reply depth ${depth} and were stopped.`,
        },
      }
    }

    // Checked after depth so a deep thread reports the more specific measurement.
    const pair = this.pairLedger(sender.name, to)
    if (pair.length >= PAIR_MAX_MESSAGES) {
      const minutes = PAIR_WINDOW_MS / 60_000
      return {
        ok: false,
        recipients: [],
        reason:
          `you have sent ${to} ${pair.length} messages in ${minutes} minutes, which is the limit. ` +
          'Starting a new thread does not reset this. The exchange has been escalated to the ' +
          'human queue — wait for them rather than rephrasing and retrying.',
        deliveries: [],
        escalate: {
          from: sender.name,
          to,
          kind: 'exchange_rate',
          value: pair.length,
          summary:
            `${sender.name} sent ${to} ${pair.length} messages in ${minutes} minutes and was ` +
            'stopped. They may be volleying across separate threads, which the depth limit cannot see.',
        },
      }
    }
    pair.push(this.now())

    const message = this.build(sender.name, text, inReplyTo === undefined ? {} : { inReplyTo })
    const live = !target[1].dnd
    return {
      ok: true,
      msgId: message.msgId,
      recipients: [to],
      deliveries: [{ conn: target[0], message, live }],
      ...(live
        ? {}
        : {
            reason:
              `${to} is not taking pushes right now. The message is in their inbox and they will ` +
              'see it when they next look, so do not resend it.',
          }),
    }
  }

  /** Routes to every registered session except the sender. */
  broadcast(conn: C, text: string): RouteResult<C> {
    const sender = this.entries.get(conn)
    if (!sender) return { ok: false, recipients: [], reason: 'not registered', deliveries: [] }

    const message = this.build(sender.name, text, { broadcast: true })
    const deliveries: Delivery<C>[] = []
    for (const [target, entry] of this.entries) {
      if (target === conn) continue
      deliveries.push({ conn: target, message, live: !entry.dnd })
    }

    // Charged against the budget even when suppressed, or hitting the limit would
    // make every subsequent broadcast free.
    const amplified = Buffer.byteLength(text) * deliveries.length
    const ledger = this.broadcastLedger(sender.name)
    const spent = ledger.reduce((total, s) => total + s.bytes, 0)
    if (deliveries.length > 0) ledger.push({ at: this.now(), bytes: amplified })

    const overBudget = deliveries.length > 0 && spent + amplified > BROADCAST_BUDGET_BYTES
    return {
      ok: true,
      msgId: message.msgId,
      recipients: deliveries.map(d => this.nameOf(d.conn) ?? '?'),
      deliveries,
      ...(overBudget
        ? {
            suppressLive: true,
            reason:
              `broadcast budget spent (${spent + amplified} of ${BROADCAST_BUDGET_BYTES} amplified ` +
              `bytes in ${BROADCAST_WINDOW_MS / 1000}s). Held in every recipient's inbox rather than ` +
              'pushed live, so nothing is lost and resending would only duplicate it. ' +
              'Prefer chat_send to the sessions that actually need this.',
          }
        : {}),
    }
  }

  drop(conn: C): string | undefined {
    const name = this.entries.get(conn)?.name
    this.entries.delete(conn)
    return name
  }
}
