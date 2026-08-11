import { randomUUID } from 'node:crypto'
import { hostChannelStatus, type ChannelStatus } from './host-channels.js'
import {
  DECLARED_MAX_BYTES,
  DECLARED_MAX_KEYS,
  DECLARED_MAX_VALUE_CHARS,
  MAX_MULTICAST_RECIPIENTS,
  RESERVED_NAMES,
  SELF_TAG,
  SUBSCRIBABLE_KINDS,
  TAG_MAX_PER_APPLIER,
  TAG_MAX_PER_SESSION,
  tagProblem,
  type DeclaredPresence,
  type DeliveredMessage,
  type ObservedPresence,
  type RecipientResult,
  type RecipientStatus,
  type SessionInfo,
  type SessionStatus,
  type SessionTag,
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

/**
 * Clamp a declared bag to the published budget, wherever one enters.
 *
 * Enforced HERE as well as at the tool boundary, for the same reason
 * `sanitizeSubscriptions` is: the MCP tool is one client of this socket, and a
 * raw client on the same 0600 socket can send whatever it likes. The tool
 * REJECTS an over-budget bag so the model learns; this layer silently drops what
 * is over the line, because a socket client has nobody to tell. Values are
 * type-checked rather than cast (CC-8): this is model-supplied structure.
 */
/**
 * The observed presence a reader sees, with Claude Code's session id folded in.
 *
 * Stored beside `observed` and merged only here, because it arrives as a
 * top-level field of the register frame but belongs on the observed side of the
 * trust split — it is read from the session's own environment, never typed by a
 * model. Undefined when there is nothing to report, so "observed nothing" and
 * "observed an empty object" stay the same state.
 */
const observedOf = (entry: {
  observed?: ObservedPresence
  sessionId?: string
}): ObservedPresence | undefined => {
  if (entry.observed === undefined && entry.sessionId === undefined) return undefined
  return {
    ...entry.observed,
    ...(entry.sessionId === undefined ? {} : { claudeSessionId: entry.sessionId }),
  }
}

const sanitizeDeclared = (declared: DeclaredPresence): DeclaredPresence => {
  const kept: DeclaredPresence = {}
  let bytes = 0
  for (const [key, value] of Object.entries(declared)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue
    if (Object.keys(kept).length >= DECLARED_MAX_KEYS) break
    const trimmed = value.slice(0, DECLARED_MAX_VALUE_CHARS)
    bytes += Buffer.byteLength(key) + Buffer.byteLength(trimmed)
    if (bytes > DECLARED_MAX_BYTES) break
    kept[key] = trimmed
  }
  return kept
}

/**
 * Turn self-declared tag strings from a `register` frame into attributed tags.
 *
 * Silently drops what is malformed or over budget, the same way `sanitizeDeclared`
 * clamps rather than rejects: a registration answers ok/reason about the NAME, and
 * failing a whole registration over a stray tag would cost a session the bus. The
 * `tag` frame, which exists to do exactly this, rejects instead.
 */
const sanitizeSelfTags = (tags: string[], at: number): SessionTag[] => {
  const kept: SessionTag[] = []
  for (const tag of tags) {
    if (kept.length >= TAG_MAX_PER_SESSION) break
    if (tagProblem(tag) !== undefined) continue
    if (kept.some(held => held.tag === tag)) continue
    kept.push({ tag, by: SELF_TAG, at })
  }
  return kept
}

/** Selectors are the identity of a subscription, which is what makes re-subscribing idempotent. */
const sameSelector = (a: SubscriptionSelector, b: SubscriptionSelector): boolean => {
  if ('all' in a || 'all' in b) return 'all' in a && 'all' in b
  if ('name' in a || 'name' in b) return 'name' in a && 'name' in b && a.name === b.name
  if ('spawnedBy' in a || 'spawnedBy' in b) return 'spawnedBy' in a && 'spawnedBy' in b
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
   * Claude Code's own pid, as opposed to `pid` above, which is the MCP
   * subprocess that sent the registration.
   *
   * Presence data for the same reason `termSessionId` is: a pid names a running
   * process and means nothing once that process is gone, so it belongs to the
   * lifetime of a connection rather than to the log. Recording it durably would
   * reintroduce exactly what the socket-as-lease design removed — a stored pid
   * that has to be re-checked, and pid reuse to be wrong about.
   */
  hostPid?: number
  /**
   * Whether that host can actually receive a channel push, resolved once at
   * register time from `hostPid` (CC-73).
   *
   * Presence data like everything around it, and necessarily so: it is a fact
   * about a running process's argv, and a re-register is exactly when it can
   * have changed — a session that switched surface is a different process.
   */
  channels?: ChannelStatus
  /**
   * The name was derived from the session's directory, not chosen by it (CC-82).
   * Presence data like everything around it: a rename clears it, and it is a
   * fact about how THIS registration was made rather than about the identity.
   */
  provisional?: boolean
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
  /**
   * Many per session: a session is usually in more than one conversation. Each
   * carries WHO applied it (CC-13), because a peer's label and a session's own
   * claim about itself are different things and a reader must be able to tell
   * them apart. Presence data like everything else here.
   */
  tags: SessionTag[]
  /** Ephemeral like everything else here — re-declared on register, never stored. */
  subscriptions: Subscription[]
  /**
   * Structured presence (CC-11). Both are presence data for the same reason
   * `hostPid` and the anchor are: a branch is true of a running process in a
   * directory, and means nothing once that process is gone. Re-declared on
   * register exactly as `tags` and `subscriptions` are, never persisted.
   */
  observed?: ObservedPresence
  declared?: DeclaredPresence
  /**
   * Claude Code's own session id, off the register frame. Kept beside `observed`
   * rather than inside it because it arrives as a top-level field of the frame,
   * and folded into `observed` on the way out — see `list()`. Presence-scoped
   * like everything else here.
   */
  sessionId?: string
  /**
   * Names of agents spawned by THIS connection, for resolving a `spawnedBy`
   * selector. Presence-scoped like the anchor and the subscriptions themselves —
   * it dies with the socket, carried across a re-register on the same conn but
   * never persisted, since it is only ever consulted while the requester is
   * still connected to receive the push.
   */
  spawned: Set<string>
  registeredAt: number
  lastSeen: number
}

/** What a caller holding a connection may read back about it. */
export interface EntryView {
  name: string
  workingOn: string
  status: SessionStatus
  agentId?: string
  /** Claude Code's pid. Never persisted; see `Entry.hostPid`. */
  hostPid?: number
  /** When this connection registered. Lets a caller judge how fresh a name is. */
  registeredAt: number
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
  /** Everyone the message was routed to, live or held. Unchanged by CC-10. */
  recipients: string[]
  /**
   * One entry per name the sender ADDRESSED, so a multicast that missed one peer
   * can say which. Additive alongside `recipients`, which several readers
   * (cli.ts, the dashboard, the API contract) already depend on.
   */
  results: RecipientResult[]
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
 * What separates a send from a multicast from a broadcast, which is only ever
 * which budgets apply and what the recipients are told about each other.
 */
interface RouteOptions {
  inReplyTo?: string
  /** Ordered-pair rate limiting. Off for a broadcast, which is not a conversation. */
  chargePair: boolean
  /** Recipient count from which the fanout budget applies; Infinity never charges. */
  chargesFrom: number
  /** Stamp `audience` on the delivered message, so recipients see who else has it. */
  audience?: boolean
  /** Mark the message as addressed to everyone. */
  broadcast?: boolean
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
 * Fanout budget, denominated in amplified bytes (payload x recipients) because
 * fanout is the cost. On 2026-07-27 broadcasts were 3 of 17 messages but 57% of
 * all delivered bytes, so a message-count budget would have missed the problem
 * entirely. Messages to a single recipient are never throttled: fanout is where
 * the abuse lives, and starving a targeted request would break real work.
 *
 * A multicast of two or more names is charged the same way, and that is not a
 * detail. If it were not, "list every registered name in one chat_send" would be
 * a broadcast that costs nothing — a one-line bypass of the only control this
 * bus has against exactly the traffic it was built to catch.
 */
const FANOUT_WINDOW_MS = 60_000
const FANOUT_BUDGET_BYTES = 16_000

/** From how many recipients a route starts paying the fanout budget. */
const BROADCAST_CHARGES_FROM = 1
const MULTICAST_CHARGES_FROM = 2

const newMsgId = (): string => randomUUID().slice(0, 8)

/**
 * Registry and router, kept free of any I/O so routing decisions can be tested
 * directly. `C` is an opaque connection handle owned by the transport.
 */
export class Registry<C> {
  private readonly entries = new Map<C, Entry>()
  /** msgId -> chain length, so a reply can find its parent's depth in O(1). */
  private readonly depths = new Map<string, number>()
  /** Sender name -> recent fanout spend, pruned to the current window on read. */
  private readonly fanoutSpend = new Map<string, { at: number; bytes: number }[]>()
  /** "from -> to" -> send times, pruned on read. Ordered, so each way is its own budget. */
  private readonly pairSends = new Map<string, number[]>()

  constructor(
    private readonly now: () => number = Date.now,
    /**
     * Injected for the same reason `now` is: a unit test must be able to state
     * a session's channel posture outright rather than arrange a real process
     * with the right argv to imply it.
     */
    private readonly channelStatus: (hostPid: number | undefined) => ChannelStatus = hostChannelStatus,
  ) {}

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

  /** This sender's fanout spend, pruned to the current window in place. */
  private fanoutLedger(name: string): { at: number; bytes: number }[] {
    const cutoff = this.now() - FANOUT_WINDOW_MS
    const kept = (this.fanoutSpend.get(name) ?? []).filter(s => s.at > cutoff)
    this.fanoutSpend.set(name, kept)
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
      hostPid?: number
      provisional?: boolean
      termSessionId?: string
      tags?: string[]
      subscriptions?: Subscription[]
      observed?: ObservedPresence
      declared?: DeclaredPresence
      sessionId?: string
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
      ...(input.hostPid === undefined ? {} : { hostPid: input.hostPid }),
      // Absent rather than false on a chosen name, so a re-register that names
      // itself CLEARS the mark instead of carrying it forward (CC-82).
      ...(input.provisional === true ? { provisional: true } : {}),
      // Resolved here rather than at send time: this is one `ps` per
      // registration instead of one per recipient per message, and the answer
      // cannot change without the host process changing, which is a re-register.
      channels: this.channelStatus(input.hostPid),
      ...(input.termSessionId === undefined ? {} : { termSessionId: input.termSessionId }),
      // A re-register re-declares both, which is how a resumed agent gets its
      // subscriptions back without anything having persisted them.
      tags: input.tags ? sanitizeSelfTags(input.tags, this.now()) : (existing?.tags ?? []),
      subscriptions: input.subscriptions
        ? sanitizeSubscriptions(input.subscriptions)
        : (existing?.subscriptions ?? []),
      // Same re-declare-or-carry rule, so a resumed agent keeps the presence it
      // had rather than reappearing as a session nobody can place.
      ...((input.observed ?? existing?.observed)
        ? { observed: input.observed ?? (existing?.observed as ObservedPresence) }
        : {}),
      ...((input.declared ?? existing?.declared)
        ? {
            declared: input.declared
              ? sanitizeDeclared(input.declared)
              : (existing?.declared as DeclaredPresence),
          }
        : {}),
      // Same re-declare-or-carry rule: a resumed agent keeps the transcript it
      // was already addressable by.
      ...((input.sessionId ?? existing?.sessionId) === undefined
        ? {}
        : { sessionId: (input.sessionId ?? existing?.sessionId) as string }),
      spawned: existing?.spawned ?? new Set(),
      status: existing?.status ?? 'available',
      awaitingApproval: existing?.awaitingApproval ?? false,
      dnd: existing?.dnd ?? false,
      registeredAt: existing?.registeredAt ?? this.now(),
      lastSeen: this.now(),
    })
    return { ok: true, ...(evicted === undefined ? {} : { evicted }) }
  }

  /**
   * `declared` REPLACES rather than merges: a session correcting "I am on CC-10"
   * to "I am on CC-11" must not end up asserting both, and a merge has no way to
   * express a retraction. An empty record therefore clears it.
   */
  setStatus(
    conn: C,
    status: SessionStatus,
    workingOn?: string,
    dnd?: boolean,
    declared?: DeclaredPresence,
  ): boolean {
    const entry = this.entries.get(conn)
    if (!entry) return false
    entry.status = status
    if (workingOn !== undefined) entry.workingOn = workingOn
    if (dnd !== undefined) entry.dnd = dnd
    if (declared !== undefined) entry.declared = sanitizeDeclared(declared)
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
      ...(observedOf(e) === undefined ? {} : { observed: observedOf(e) as ObservedPresence }),
      ...(e.provisional === true ? { provisional: true } : {}),
      // Omitted when empty rather than sent as `{}`: "declared nothing" and
      // "declared an empty bag" are the same state and should render the same.
      ...(e.declared === undefined || Object.keys(e.declared).length === 0 ? {} : { declared: e.declared }),
      // Same omit-when-empty rule, and every session's tags go to every reader:
      // a session must be able to see a label a peer put on it, which it can only
      // do if tags are on the roster rather than answered to whoever asked.
      ...(e.tags.length === 0 ? {} : { tags: [...e.tags] }),
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
   * Claude Code's own pid for a name, for the caller that has to END a session
   * it did not launch (CC-77: retire).
   *
   * Presence rather than identity, and that is exactly why retire reads it here
   * instead of from the supervisor's launch handle: handles live only in the
   * broker's memory, but a session re-registers after every broker restart — so
   * this is available precisely in the case where the handle is gone.
   *
   * Undefined covers two different things the caller must tell apart, which is
   * what `connFor` is for: not registered at all (nothing to end), versus
   * registered by an MCP server too old to report `hostPid`.
   */
  hostPidFor(name: string): number | undefined {
    return this.findByName(name)?.[1].hostPid
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
   * The git facts observed for this connection at registration.
   *
   * Read from the entry rather than through `EntryView`, which is a deliberately
   * narrow projection. A claim needs the worktree and repository a session is
   * actually in, and taking those from the CONNECTION is what stops a session
   * claiming somewhere it merely says it is (CC-56).
   */
  observedFor(conn: C): ObservedPresence | undefined {
    const entry = this.entries.get(conn)
    return entry === undefined ? undefined : observedOf(entry)
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

  /** Every tag on this connection, peer-applied ones included, with attribution. */
  tagsOf(conn: C): SessionTag[] {
    return this.entries.get(conn)?.tags ?? []
  }

  /**
   * Only the tags this session declared about ITSELF, as plain strings.
   *
   * This is what a teleport carries across, and the distinction is the whole
   * point (HUMAN DECISION, CC-13): a peer-applied tag surviving a teleport would
   * arrive on a fresh identity as `by: 'self'`, laundering someone else's label
   * into the descendant's own declaration. A successor may of course be tagged
   * again by the peer that meant it.
   */
  selfTagsOf(conn: C): string[] {
    return (this.entries.get(conn)?.tags ?? []).filter(t => t.by === SELF_TAG).map(t => t.tag)
  }

  /**
   * Add and remove tags on `target` (or on the caller, when target is absent).
   *
   * Attribution is resolved HERE from the applying connection, never taken from
   * the frame — the discipline `anchorFor` follows for panes and `teleport` for
   * its subject. Rejects rather than clamping: unlike a registration, this call
   * exists only to change tags, so there is always somewhere to report the reason.
   */
  applyTags(
    conn: C,
    input: { target?: string; add?: string[]; remove?: string[] },
  ): {
    ok: boolean
    reason?: string
    subject?: string
    tags: SessionTag[]
    added: string[]
    removed: string[]
  } {
    const applier = this.entries.get(conn)
    const fail = (reason: string) => ({ ok: false, reason, tags: [], added: [], removed: [] })
    if (!applier) return fail('register before tagging')

    const found: [C, Entry] | undefined =
      input.target === undefined ? [conn, applier] : this.findByName(input.target)
    if (!found) return fail(`no active session named "${input.target}"`)
    const subject = found[1]
    const onSelf = found[0] === conn

    const add = input.add ?? []
    const remove = input.remove ?? []
    if (add.length === 0 && remove.length === 0) return fail('name at least one tag to add or remove')
    for (const tag of [...add, ...remove]) {
      const problem = tagProblem(tag)
      if (problem) return fail(problem)
    }

    // A session owns its own presence, so it may remove ANY tag on itself. On a
    // PEER it may only remove what it applied itself — otherwise one agent could
    // strip a label a third party put on another, which is the quiet way to undo
    // someone else's coordination without anyone seeing it happen.
    if (!onSelf) {
      for (const tag of remove) {
        const held = subject.tags.find(t => t.tag === tag)
        if (held === undefined) continue
        if (held.by !== applier.name)
          return fail(
            `"${tag}" on ${subject.name} was applied by ${held.by === SELF_TAG ? subject.name : held.by}; ` +
              'you may only remove tags you applied yourself',
          )
      }
    }

    const wanted = subject.tags.filter(t => !remove.includes(t.tag))
    const removed = subject.tags.filter(t => remove.includes(t.tag)).map(t => t.tag)
    const added: string[] = []
    const by = onSelf ? SELF_TAG : applier.name
    for (const tag of add) {
      if (wanted.some(t => t.tag === tag)) continue
      if (wanted.length >= TAG_MAX_PER_SESSION)
        return fail(`${subject.name} already carries ${TAG_MAX_PER_SESSION} tags, which is the limit`)
      if (this.tagsAppliedBy(applier.name) - removed.length + added.length >= TAG_MAX_PER_APPLIER)
        return fail(`you have placed ${TAG_MAX_PER_APPLIER} tags across this bus, which is the limit`)
      wanted.push({ tag, by, at: this.now() })
      added.push(tag)
    }

    subject.tags = wanted
    return { ok: true, subject: subject.name, tags: [...subject.tags], added, removed }
  }

  /** How many tags one applier is holding across every session, its own included. */
  private tagsAppliedBy(name: string): number {
    let count = 0
    for (const [, entry] of this.entries)
      for (const tag of entry.tags)
        if (tag.by === name || (tag.by === SELF_TAG && entry.name === name)) count += 1
    return count
  }

  /**
   * What this connection is subscribed to, so a teleport can carry it across.
   *
   * Subscriptions are registry-only and ephemeral — nothing persists them, and
   * the descendant is a new process that will never see the predecessor's
   * `subscribe` calls. Readable exactly when it matters: a session is by
   * definition connected at the moment it asks to teleport.
   */
  subscriptionsOf(conn: C): Subscription[] {
    return this.entries.get(conn)?.subscriptions ?? []
  }

  /**
   * Every session currently carrying a tag, for resolving a `tag` selector or a
   * `toTag` address.
   *
   * MATCHES REGARDLESS OF WHO APPLIED THE TAG, on purpose: "whoever owns src" is
   * a question about the label, and restricting it to self-declared ones would
   * make a peer's tag invisible to the only operation it exists for.
   *
   * A TAG IS NEVER AUTHORIZATION. Anything reached this way is reached because a
   * string matched — an agent can tag itself `owner:src` in one call, so nothing
   * downstream may read a match as a grant of ownership, priority, or the right
   * to be obeyed. Same boundary `from` has against `source`: it says who, never
   * what they are allowed to do.
   */
  private namesWithTag(tag: string): Set<string> {
    const names = new Set<string>()
    for (const entry of this.entries.values())
      if (entry.tags.some(held => held.tag === tag)) names.add(entry.name)
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
        if ('spawnedBy' in sub.selector) return entry.spawned.has(event.subject)
        return this.namesWithTag(sub.selector.tag).has(event.subject)
      })
      if (wants) matched.push(conn)
    }
    return matched
  }

  /**
   * Record that `conn` spawned `name`, so a later `spawnedBy` subscription
   * resolves without the requester having named the agent itself. Called once,
   * right after a spawn succeeds — never inferred from the log, since only the
   * socket layer knows which connection actually asked.
   */
  recordSpawn(conn: C, name: string): void {
    this.entries.get(conn)?.spawned.add(name)
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

  /**
   * Bind a durable identity to a connection after it has registered.
   *
   * Separate from `register` because an adopted identity is resolved or minted
   * only once the registration has succeeded — minting first would strand an
   * identity in the log every time a name turned out to be held. Note this is
   * NOT a second route to the takeover rule above: by the time this runs, the
   * name is already held by this connection.
   */
  bindIdentity(conn: C, agentId: string): void {
    const entry = this.entries.get(conn)
    if (entry) entry.agentId = agentId
  }

  entryFor(conn: C): EntryView | undefined {
    const entry = this.entries.get(conn)
    if (!entry) return undefined
    return {
      name: entry.name,
      workingOn: entry.workingOn,
      status: entry.status,
      ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
      ...(entry.hostPid === undefined ? {} : { hostPid: entry.hostPid }),
      registeredAt: entry.registeredAt,
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

  /**
   * The depth breaker, which stops a whole route rather than one recipient: a
   * thread is a property of the exchange, not of who happens to be on the list.
   *
   * It exists for the case nobody is watching. Two agents that ignore the depth
   * stamps would otherwise ping-pong indefinitely, burning tokens in both while
   * the human sees only a routing log they are not tailing.
   */
  private depthRefusal(from: string, targets: string[], inReplyTo?: string): RouteResult<C> | undefined {
    const depth = this.depthFor(inReplyTo)
    if (depth < THREAD_MAX_DEPTH) return undefined
    const to = targets.join(', ')
    return {
      ok: false,
      recipients: [],
      results: targets.map(name => ({ name, status: 'refused' as const, reason: 'thread too deep' })),
      reason:
        `this reply would be depth ${depth}, past the limit of ${THREAD_MAX_DEPTH}. ` +
        'The thread has been escalated to the human queue. Do not start a fresh thread ' +
        'to continue it — wait for the human, who can see both sides.',
      deliveries: [],
      escalate: {
        from,
        to,
        kind: 'thread_depth',
        value: depth,
        summary: `${from} and ${to} reached reply depth ${depth} and were stopped.`,
      },
    }
  }

  /**
   * The ordered-pair rate limit for ONE recipient, charged on the way through so
   * a route that is refused for some other reason costs the sender nothing.
   */
  private chargePair(from: string, to: string): { reason: string; escalate: Escalation } | undefined {
    const pair = this.pairLedger(from, to)
    if (pair.length < PAIR_MAX_MESSAGES) {
      pair.push(this.now())
      return undefined
    }
    const minutes = PAIR_WINDOW_MS / 60_000
    return {
      reason:
        `you have sent ${to} ${pair.length} messages in ${minutes} minutes, which is the limit. ` +
        'Starting a new thread does not reset this. The exchange has been escalated to the ' +
        'human queue — wait for them rather than rephrasing and retrying.',
      escalate: {
        from,
        to,
        kind: 'exchange_rate',
        value: pair.length,
        summary:
          `${from} sent ${to} ${pair.length} messages in ${minutes} minutes and was ` +
          'stopped. They may be volleying across separate threads, which the depth limit cannot see.',
      },
    }
  }

  /**
   * Turn addressed names into a per-name verdict and the entries that will
   * actually receive something. Order is preserved so the sender reads its own
   * list back; duplicates collapse, since addressing a peer twice is a typo and
   * charging them twice for it would be a way to double a rate limit.
   */
  private resolveTargets(
    conn: C,
    from: string,
    targets: string[],
    chargePair: boolean,
  ): { results: RecipientResult[]; hits: [C, Entry][]; escalate?: Escalation } {
    const results: RecipientResult[] = []
    const hits: [C, Entry][] = []
    let escalate: Escalation | undefined
    for (const name of [...new Set(targets)]) {
      const found = this.findByName(name)
      if (!found) {
        results.push({ name, status: 'no_such_session', reason: `no active session named "${name}"` })
        continue
      }
      if (found[0] === conn) {
        results.push({ name, status: 'self', reason: 'cannot send to yourself' })
        continue
      }
      const refused = chargePair ? this.chargePair(from, name) : undefined
      if (refused) {
        results.push({ name, status: 'refused', reason: refused.reason })
        escalate ??= refused.escalate
        continue
      }
      results.push({ name, ...this.deliveryVerdict(found[1]) })
      hits.push(found)
    }
    return { results, hits, ...(escalate === undefined ? {} : { escalate }) }
  }

  /**
   * What to tell the sender about a recipient the broker is going to write to.
   *
   * The push happens either way — the message is logged and `chat_inbox` will
   * return it — so none of these are failures. What differs is whether the
   * recipient will be WOKEN by it, and that is the part a sender was previously
   * told wrongly: a host without the channel flag drops the notification
   * client-side, so `delivered` was true of the socket write and false of
   * everything the sender actually cared about (CC-73).
   */
  private deliveryVerdict(entry: Entry): { status: RecipientStatus; reason?: string } {
    if (entry.dnd) return { status: 'held' }
    if (entry.channels === 'no')
      return {
        status: 'no_channel',
        reason:
          `"${entry.name}" was started without agent-chat on its --channels flag, so it is not woken by ` +
          'pushes. The message is in its inbox and it will see it on its next chat_inbox.',
      }
    return { status: 'delivered' }
  }

  /**
   * Charge the fanout budget, returning the running total once it is blown.
   *
   * Charged even when the result is suppressed, or hitting the limit would make
   * every subsequent fanout free — which is the opposite of a budget.
   */
  private chargeFanout(from: string, text: string, count: number, chargesFrom: number): number | undefined {
    if (count < chargesFrom) return undefined
    const amplified = Buffer.byteLength(text) * count
    const ledger = this.fanoutLedger(from)
    const spent = ledger.reduce((total, s) => total + s.bytes, 0)
    ledger.push({ at: this.now(), bytes: amplified })
    return spent + amplified > FANOUT_BUDGET_BYTES ? spent + amplified : undefined
  }

  /**
   * The one router behind `send`, `multicast` and `broadcast`. They differ only
   * in who they resolve and what they are charged for, and keeping that in one
   * place is what stops a fourth fanout path shipping without a budget.
   */
  private route(conn: C, targets: string[], text: string, opts: RouteOptions): RouteResult<C> {
    const sender = this.entries.get(conn)
    if (!sender) return { ok: false, recipients: [], results: [], reason: 'not registered', deliveries: [] }

    // Before anything is charged, so a refused thread costs the sender nothing.
    const tooDeep = this.depthRefusal(sender.name, targets, opts.inReplyTo)
    if (tooDeep) return tooDeep

    const { results, hits, escalate } = this.resolveTargets(conn, sender.name, targets, opts.chargePair)
    if (hits.length === 0 && !opts.broadcast) {
      const failed = results.find(r => r.status !== 'delivered' && r.status !== 'held')
      return {
        ok: false,
        recipients: [],
        results,
        reason: failed?.reason ?? 'nobody was addressed',
        deliveries: [],
        // Only meaningful for a two-party exchange; with a list there is no one
        // pair for the human to look at, and the per-recipient status says it.
        ...(escalate && targets.length === 1 ? { escalate } : {}),
      }
    }

    const names = hits.map(([, entry]) => entry.name)
    const message = this.build(sender.name, text, {
      ...(opts.inReplyTo === undefined ? {} : { inReplyTo: opts.inReplyTo }),
      ...(opts.broadcast ? { broadcast: true } : {}),
      // A one-name multicast is a directed send by another spelling, so it gets
      // no audience: there is nobody else on it for a recipient to defer to.
      ...(opts.audience && names.length > 1 ? { audience: names } : {}),
    })
    const deliveries: Delivery<C>[] = hits.map(([target, entry]) => ({
      conn: target,
      message,
      live: !entry.dnd,
    }))

    const overBudget = this.chargeFanout(sender.name, text, deliveries.length, opts.chargesFrom)
    const held = deliveries.filter(d => !d.live).map(d => this.nameOf(d.conn) ?? '?')
    return {
      ok: true,
      msgId: message.msgId,
      recipients: names,
      results,
      deliveries,
      ...(overBudget === undefined
        ? {}
        : {
            suppressLive: true,
            reason:
              `fanout budget spent (${overBudget} of ${FANOUT_BUDGET_BYTES} amplified ` +
              `bytes in ${FANOUT_WINDOW_MS / 1000}s). Held in every recipient's inbox rather than ` +
              'pushed live, so nothing is lost and resending would only duplicate it. ' +
              'Prefer chat_send to the sessions that actually need this.',
          }),
      ...(overBudget === undefined && held.length > 0
        ? {
            reason:
              `${held.join(', ')} ${held.length === 1 ? 'is' : 'are'} not taking pushes right now. ` +
              'The message is in their inbox and they will see it when they next look, so do not resend it.',
          }
        : {}),
    }
  }

  /** Routes to exactly one session, or to none if the name isn't registered. */
  send(conn: C, to: string, text: string, inReplyTo?: string): RouteResult<C> {
    return this.route(conn, [to], text, {
      chargePair: true,
      chargesFrom: Infinity,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
    })
  }

  /**
   * Routes to exactly the named sessions (CC-10). Unknown names are reported per
   * recipient rather than failing the call: a list of five where one peer has
   * exited is four useful deliveries, and refusing all five teaches the sender to
   * reach for chat_broadcast instead — which is strictly worse for everyone.
   */
  multicast(conn: C, to: string[], text: string, inReplyTo?: string): RouteResult<C> {
    return this.route(conn, to, text, {
      chargePair: true,
      chargesFrom: MULTICAST_CHARGES_FROM,
      audience: true,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
    })
  }

  /**
   * Routes to whoever carries `tag` (CC-13), through the SAME path a multicast
   * takes — same pair charge, same fanout budget, same per-recipient results.
   * Addressing by tag is a way of naming recipients, not a way of paying less
   * for the same fanout.
   *
   * A tag nothing carries FAILS. `ok: true` with an empty recipient list would be
   * a call that looked delivered and reached nobody, which is the worst outcome
   * available here: the sender goes on believing the work was handed off.
   */
  multicastTag(conn: C, tag: string, text: string, inReplyTo?: string): RouteResult<C> {
    const sender = this.entries.get(conn)
    if (!sender) return { ok: false, recipients: [], results: [], reason: 'not registered', deliveries: [] }

    const refuse = (reason: string): RouteResult<C> => ({
      ok: false,
      recipients: [],
      results: [],
      reason,
      deliveries: [],
    })
    const carriers = this.namesWithTag(tag)
    if (carriers.size === 0) return refuse(`no session carries tag "${tag}"`)
    // Dropped rather than reported as a `self` miss: carrying the tag you are
    // addressing is the normal case for a working group, and reading back "you
    // were not delivered to" for it is noise, not information.
    const targets = [...carriers].filter(name => name !== sender.name)
    if (targets.length === 0) return refuse(`you are the only session carrying tag "${tag}"`)
    if (targets.length > MAX_MULTICAST_RECIPIENTS)
      return refuse(
        `${targets.length} sessions carry tag "${tag}", past the limit of ${MAX_MULTICAST_RECIPIENTS} ` +
          'for one directed send. Name the sessions that actually need this, or broadcast.',
      )

    return this.route(conn, targets, text, {
      chargePair: true,
      chargesFrom: MULTICAST_CHARGES_FROM,
      audience: true,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
    })
  }

  /** Routes to every registered session except the sender. */
  broadcast(conn: C, text: string): RouteResult<C> {
    const everyoneElse: string[] = []
    for (const [target, entry] of this.entries) if (target !== conn) everyoneElse.push(entry.name)
    return this.route(conn, everyoneElse, text, {
      chargePair: false,
      chargesFrom: BROADCAST_CHARGES_FROM,
      broadcast: true,
    })
  }

  drop(conn: C): string | undefined {
    const name = this.entries.get(conn)?.name
    this.entries.delete(conn)
    return name
  }
}
