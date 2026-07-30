// Wire protocol between a session's MCP subprocess and the shared broker.
// Newline-delimited JSON over a unix socket.

export const SESSION_STATUSES = ['working', 'available', 'blocked'] as const

export type SessionStatus = (typeof SESSION_STATUSES)[number]

export interface SessionInfo {
  name: string
  workingOn: string
  cwd: string
  status: SessionStatus
  /** Holding pushes; messages still accumulate in the inbox. Orthogonal to status. */
  dnd: boolean
  idleMs: number
  registeredAt: number
}

/**
 * The human is a queue, not a session: nothing holds a socket for it, so items
 * accumulate whether or not anyone is attached. Reserving the name here also
 * stops a session registering as `human` and inheriting the user's authority in
 * how other sessions read the `from` attribute.
 */
export const HUMAN = 'human'
export const RESERVED_NAMES = new Set([HUMAN, 'user', 'system', 'claude', 'all', 'everyone'])

/**
 * Every event kind, as a runtime value rather than only a type.
 *
 * This is deliberate and it is load-bearing. The SSE contract enumerates this
 * union, and test files are excluded from tsconfig — so a purely type-level
 * exhaustiveness guard is silently inert and a new kind can slip past the
 * contract with nothing failing. Deriving the type from an array makes the list
 * checkable at runtime, which is the only place a check actually runs here.
 * Same shape as SESSION_STATUSES above.
 */
export const EVENT_KINDS = [
  'message',
  'broadcast',
  'question',
  'notice',
  'answer',
  'resolution',
  'approval_request',
  'registered',
  'deregistered',
  'route_failed',
  // Agent identity lifecycle. Landed ahead of any agent code on purpose: this
  // union is enumerated in the SSE contract, so adding kinds later unfreezes
  // that contract and re-serialises everything built against it.
  //
  // Id convention, and it is load-bearing rather than cosmetic: `agent_spawned`
  // puts the AGENT ID in `msg_id`, and every later row puts it in `ref`. That
  // makes both hot queries hit indexes that already exist — "the spawn record
  // for agent X" on events_msg_id, "everything that happened to agent X" on
  // events_ref.
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  // Teleport (CC-20). Two kinds rather than one with a `meta.phase`: "wrote its
  // handoff" and "the countdown ran out" are different instants, and a query for
  // either should not have to filter on a stringly field.
  'agent_handoff',
  'agent_stood_down',
  'isolation_allocated',
  'isolation_released',
  // Refusals are events rather than just `reason` strings on a reply: they are
  // the security-relevant thing, and must be in the log whether or not anyone
  // was watching at the time.
  'agent_spawn_refused',
  'verdict_refused',
] as const

export type EventKind = (typeof EVENT_KINDS)[number]

/**
 * What a session may ask to be pushed. LIFECYCLE ONLY, and the omissions are the
 * point: `message`, `broadcast`, `question` and `answer` are absent so that no
 * subscription can turn into a wiretap on traffic between other peers. A global
 * subscriber learns who is here, never what they said.
 *
 * Reading another session's trail stays possible through chat_activity, which is
 * explicit, one session at a time, and itself logged.
 *
 * Note this is a filter over kinds that already exist. Subscriptions deliberately
 * add NO new EventKind, because the union is frozen into the SSE contract and
 * extending it re-serialises everything built against it.
 *
 * `agent_handoff` is absent for a stronger reason than the rest: its body is a
 * whole document, and `SystemEventFeed.offer` copies a row's body into the
 * pushed event. Subscribing to it would fan one session's handoff into every
 * subscriber's context — a content leak by construction, into the one channel
 * whose stated guarantee is "you learn who is here, never what anyone said".
 * Succession is already visible through the descendant's `agent_spawned` and the
 * predecessor's `agent_retired`, both of which are here.
 */
export const SUBSCRIBABLE_KINDS = [
  'registered',
  'deregistered',
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  'agent_spawn_refused',
] as const satisfies readonly EventKind[]

export type SubscribableKind = (typeof SUBSCRIBABLE_KINDS)[number]

/**
 * Who an event must be about for a subscriber to hear it. `all` is the noisy one
 * and exists knowingly — coalescing is what makes it survivable. `spawnedBy` is
 * provenance rather than naming: it matches whatever the subscribing connection
 * has itself spawned, so it stays correct as more agents come and go without the
 * subscriber having to name each one or repoint at a shared tag.
 */
export type SubscriptionSelector = { all: true } | { name: string } | { tag: string } | { spawnedBy: 'self' }

export interface Subscription {
  selector: SubscriptionSelector
  kinds: SubscribableKind[]
}

/**
 * A log row reshaped for a subscriber. `subject` is who the event is about,
 * resolved as target-then-actor: `agent_spawned` names the agent in `target`
 * while `agent_exited` has only `actor`, and a subscriber cares about the agent
 * either way.
 */
export interface SystemEvent {
  kind: SubscribableKind
  subject: string
  at: number
  detail?: string
}

/** The two SSE event names that are not event kinds. See api-contract.ts. */
export const NON_KIND_SSE_EVENTS = ['session_status', 'reset'] as const

/**
 * Two kinds are deliberately absent.
 *
 * A permission verdict is a `resolution` row (actor `human`, `ref` the
 * approval_request's msg_id, body `allow`/`deny`) — the same shape `dismiss`
 * already writes, so the existing CLOSED subquery retires it from humanQueue()
 * with no query change. An `approval_verdict` kind would leave the item open
 * forever until someone also taught CLOSED about it.
 *
 * "Blocked" is derived, not recorded: an agent is blocked when it has an open
 * approval_request. Recording it as state would need a matching "unblocked"
 * event, and the host never sends one — when the local dialog wins the race it
 * sends the channel server nothing at all.
 */

export interface DeliveredMessage {
  msgId: string
  from: string
  text: string
  /** Set when this message answers an earlier one, carrying that message's id. */
  inReplyTo?: string
  /** True when the sender addressed everyone rather than this session specifically. */
  broadcast?: boolean
  /** Marks non-conversational deliveries, e.g. an answer coming back from the human. */
  event?: string
  /**
   * Length of the in_reply_to chain this message sits on, starting at 1. Stamped
   * into `meta` so both models can see a thread lengthening and wrap up on their
   * own, before the broker has to be blunt about it.
   */
  threadDepth?: number
  /** Set once a thread is long enough to be worth flagging, alongside threadDepth. */
  threadHint?: string
  at: number
}

/** An open item in the human queue: a projection of the log, never stored state. */
export interface QueueItem {
  msgId: string
  kind: EventKind
  from: string
  text: string
  at: number
  meta: Record<string, string>
}

/**
 * Names an agent-teams isolation strategy, and where a spawned agent's process
 * is presented. Runtime arrays rather than bare type unions for the same reason
 * EVENT_KINDS is one: profile files are user-authored JSON, so these have to be
 * checkable at the point a string arrives from disk, not only at compile time.
 */
export const ISOLATION_NAMES = ['none', 'worktree', 'file-ownership', 'toolset-limited'] as const

export type IsolationName = (typeof ISOLATION_NAMES)[number]

export const SURFACE_NAMES = ['headless', 'iterm-pane', 'iterm-tab', 'iterm-window'] as const

export type SurfaceName = (typeof SURFACE_NAMES)[number]

/** The surfaces that put the agent in front of a human who can answer a prompt. */
export const isInteractiveSurface = (surface: SurfaceName): boolean => surface !== 'headless'

/** Session -> broker. */
export type ClientMessage =
  /**
   * `agentId` is what turns a process into an existing durable identity rather
   * than a new registration: presence is ephemeral, identity is not, and
   * resuming is a new process attaching to an identity that already exists.
   */
  | {
      t: 'register'
      name: string
      workingOn: string
      cwd: string
      pid: number
      agentId?: string
      /**
       * `CLAUDE_CODE_SESSION_ID`, read by the MCP subprocess from its own
       * environment. Never asked of the model, which is what lets the broker mint
       * a durable identity for an ordinary session without that identity becoming
       * self-asserted. Absent means no adoption: an older binary, or a client that
       * is not a Claude Code session at all.
       */
      sessionId?: string
      /**
       * The pid of Claude Code itself, not of this MCP subprocess.
       *
       * `pid` above is `process.pid` — the subprocess. Signalling that severs the
       * bus and leaves Claude Code running, which is worse than either extreme
       * because the screen shows a live session that can no longer be reached.
       * This carries the one that is actually actionable. Presence data: a pid is
       * meaningless once its process is gone, so nothing persists it and nothing
       * asks `process.kill(pid, 0)` to decide whether a session is up.
       */
      hostPid?: number
      termSessionId?: string
      /** Many, not one: a session is usually in more than one conversation. */
      tags?: string[]
      subscriptions?: Subscription[]
      /**
       * Which BUILD this client is running, so a mismatch with the broker's own
       * is reported rather than inferred (CC-36).
       *
       * A session loads agent-chat from whichever entry its launcher resolved,
       * and that need not be the one the broker is running. The resulting state
       * is invisible from both sides: the client registers normally and answers
       * messages, and only its TOOL LIST is stale. Two live agents reported not
       * having a tool the broker had shipped, and nothing anywhere said the
       * builds disagreed.
       */
      build?: string
    }
  /**
   * Reclaim a registration this session already had, without asking the model.
   *
   * CC-31: registration is per-connection by design, so a replaced MCP
   * subprocess comes back with no registration and nothing prompts it to make
   * one. The model called `chat_register` earlier in the conversation and will
   * not call it again — from inside, the session looks registered.
   *
   * NAMES NO NAME, deliberately. The session id is read by the subprocess from
   * its own environment, never from the model, and the broker resolves the name
   * from its own log. That is what stops this being a way to claim a name by
   * quoting a field: the only name reachable is the one this session already
   * held.
   */
  | {
      t: 'readopt'
      sessionId: string
      cwd: string
      pid: number
      hostPid?: number
      termSessionId?: string
      build?: string
    }
  | { t: 'status'; status: SessionStatus; workingOn?: string; dnd?: boolean }
  /** Replaces any subscription with the same selector, so re-subscribing is idempotent. */
  | { t: 'subscribe'; subscriptions: Subscription[] }
  /** Omitting the selector clears every subscription this session holds. */
  | { t: 'unsubscribe'; selector?: SubscriptionSelector }
  | { t: 'list' }
  | { t: 'send'; to: string; text: string; inReplyTo?: string }
  | { t: 'broadcast'; text: string }
  | { t: 'inbox'; limit: number }
  | { t: 'ask'; text: string }
  | { t: 'notify'; text: string }
  | { t: 'queue' }
  | { t: 'answer'; msgId: string; text: string }
  | { t: 'dismiss'; msgId: string }
  | { t: 'history'; limit: number }
  /** Read one session's trail. Never delivers anything to the session being read. */
  | { t: 'activity'; name: string; limit: number }
  /** From the terminal client, which is the human and so never registers. */
  | { t: 'human_send'; to: string; text: string }
  /** Claude Code opened a permission dialog in this session. Observed, never answered. */
  | { t: 'approval'; requestId: string; toolName: string; description: string; inputPreview: string }
  // Agent teams. Declared ahead of the handlers so the wire shape is frozen
  // before three tracks start building against it; nothing routes these yet.
  | {
      t: 'spawn'
      name: string
      profile: string
      brief: string
      cwd?: string
      isolation?: IsolationName
      surface?: SurfaceName
      /** Tags and subscriptions the spawned agent starts with, before it runs. */
      tags?: string[]
      subscriptions?: Subscription[]
    }
  | { t: 'agents'; includeRetired?: boolean }
  | { t: 'retire'; name: string }
  /**
   * Hand off to a successor and end this session. NAMES NO AGENT: the subject is
   * resolved by the broker from the requesting connection, the same discipline
   * `anchor` and `parentAgentId` already follow. There is deliberately no field
   * for a target, a profile, a surface or a tool list — a teleport is a
   * continuation, and a `profile` argument would be a model authoring its own
   * privilege escalation and calling it a handoff.
   *
   * `model` is the ONE negotiable field, and it is not a privilege: an agent may
   * deliberately succeed itself onto a cheaper or stronger model. Absent means
   * "whatever this session is running on now", which is the point of teleport.
   */
  | { t: 'teleport'; handoff: string; model?: string }
  /**
   * Stop a countdown that has not fired yet. The human's veto, and it has no
   * MCP tool — see `docs/teleport.md` §4.2. The broker refuses it from a
   * REGISTERED connection, so the only caller left is someone at the CLI, who
   * could already retire or kill anything on a 0600 socket.
   */
  | { t: 'teleport_abort'; name: string }
  /**
   * Pull a headless agent into a terminal window. This one DOES name an agent,
   * and that is the deliberate divergence from `teleport` above: the case it
   * exists for is an agent too blocked to ask for itself, because a headless
   * session relays no permission prompts (CC-2). It only ever widens what a human
   * can see, and the broker refuses it for anything not already headless.
   */
  | { t: 'surface'; name: string }
  /**
   * Go headless. NAMES NO AGENT, exactly as `teleport` does not: making another
   * peer's work invisible is the operation worth making unrepresentable, so there
   * is no field to ask for it.
   */
  | { t: 'background' }

/** Broker -> session. */
export type ServerMessage =
  /**
   * `name` is set only by a readopt, where the CLIENT did not know it — the
   * broker resolved it from the log. An ordinary register already knows the name
   * it asked for and gets nothing back.
   */
  | { t: 'register_result'; ok: boolean; reason?: string; name?: string }
  | { t: 'subscribe_result'; ok: boolean; held: number; reason?: string }
  /**
   * Batched, because three agents starting together is one thing that happened,
   * not three interruptions. Distinct from `deliver` so a system event can never
   * be mistaken for a peer speaking.
   */
  | { t: 'system_events'; events: SystemEvent[] }
  | { t: 'status_result'; ok: boolean }
  | { t: 'list_result'; sessions: SessionInfo[] }
  /**
   * `held` means the message was retained for every recipient's inbox but not
   * pushed live. It is not a failure, and the sender must not resend: the content
   * is already durable in the event log and `chat_inbox` will return it.
   */
  | {
      t: 'send_result'
      ok: boolean
      msgId?: string
      recipients: string[]
      reason?: string
      held?: boolean
    }
  | { t: 'inbox_result'; messages: DeliveredMessage[] }
  | { t: 'queue_result'; items: QueueItem[] }
  | { t: 'answer_result'; ok: boolean; reason?: string }
  | { t: 'history_result'; items: QueueItem[] }
  /** `session` is absent when the name has no live registration; `events` outlives it. */
  | { t: 'activity_result'; session?: SessionInfo; events: QueueItem[] }
  | { t: 'deliver'; message: DeliveredMessage }
  /**
   * `fatal` means stop, do not reconnect. It exists for exactly one case and the
   * case is not optional: a connection displaced by a resume takeover would
   * otherwise hit its reconnect ladder, replay its registration with the same
   * agentId, and take the identity straight back — two live processes trading one
   * name forever, each a legitimate holder by the takeover rule. An ordinary
   * error stays retryable; this one ends the process that received it.
   */
  | { t: 'error'; reason: string; fatal?: boolean }
  /**
   * `warnings` carries isolation.check()'s non-fatal output back to the
   * requesting model — "you are sharing a checkout with bob" is something it
   * should be told even though the spawn succeeded.
   */
  | {
      t: 'spawn_result'
      ok: boolean
      agentId?: string
      name?: string
      reason?: string
      warnings?: string[]
    }
  | { t: 'agents_result'; agents: AgentIdentity[] }
  /**
   * Answered as soon as the handoff is recorded and the sequence is committed to,
   * NOT when the descendant is up: a visible predecessor has 30 seconds of
   * countdown left to run, and holding the reply that long would blow the
   * client's 5s request timeout and leave the model believing it failed.
   *
   * `name` is the predecessor's own name, restated rather than newly assigned —
   * the descendant keeps it (§5.1), so "the descendant's name" is not new
   * information. `agentId` is the descendant's, which is.
   */
  | {
      t: 'teleport_result'
      ok: boolean
      reason?: string
      name?: string
      agentId?: string
      /** Milliseconds until shutdown. Absent for a headless predecessor: there is no wait. */
      countdownMs?: number
      warnings?: string[]
    }
  /**
   * `surface` is where it ACTUALLY landed, which is not always what was asked
   * for: the iTerm ladder downgrades a pane or tab to a new window when the
   * anchor is gone, and a caller that reported the request rather than the
   * outcome would tell the human to look in the wrong place.
   */
  | {
      t: 'switch_result'
      ok: boolean
      reason?: string
      name?: string
      agentId?: string
      surface?: SurfaceName
      warnings?: string[]
    }

/**
 * The lifecycle an agent identity is folded into. Durable: it is a projection of
 * the event log, so it survives a broker restart in a way presence cannot.
 */
export const AGENT_LIFECYCLES = ['spawning', 'live', 'detached', 'exited', 'retired'] as const

export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number]

/**
 * How an identity came to exist, and therefore how much of it to trust.
 *
 * `spawned` — the broker minted the id AND assigned the name from a launch plan,
 * then handed both to the process in its environment. Every field is
 * broker-derived.
 *
 * `adopted` — an ordinary human-started session, given an identity by the broker
 * when it registered. The id, the Claude Code session id and the cwd are still
 * broker- or host-derived, but the NAME and the BRIEF are whatever the model
 * typed into `chat_register`. That is the weaker guarantee `from` already has
 * versus `source`, and it is recorded here rather than left to convention
 * because a roster (CC-11) and an endorsement (CC-22) need to tell the two
 * apart.
 */
export const AGENT_ORIGINS = ['spawned', 'adopted'] as const

export type AgentOrigin = (typeof AGENT_ORIGINS)[number]

/**
 * A durable agent identity, produced by the A1 read model (`agents/identity.ts`).
 * Presence is deliberately NOT in here — that is the registry's job, and it is
 * ephemeral by design. The two are paired at render time, never stored together.
 *
 * The first six fields were frozen with the rest of the contract in step 2a; the
 * rest were added by A1 under the "may add fields" allowance. `isolation` and
 * `surface` are plain strings rather than IsolationName / SurfaceName because
 * they are read back out of a free-text `meta` blob, and the fold cannot promise
 * a value written by an older binary is still in either union.
 */
export interface AgentIdentity {
  agentId: string
  name: string
  profile: string
  state: AgentLifecycle
  /** Whether the name and brief are broker-assigned or self-reported. */
  origin: AgentOrigin
  spawnedBy: string
  spawnedAt: number
  brief: string
  cwd: string
  isolation: string
  surface: string
  /** The uuid passed to --session-id. The resume handle. */
  sessionId: string
  /** Timestamp of the newest row referencing this identity, spawn included. */
  lastEventAt: number
  /**
   * How many teleports deep this identity is: 1 for one that has never
   * teleported, incrementing per hop. Broker-derived, like `teleportFrom` —
   * written by the broker from its own resolution of the predecessor, never from
   * a client-supplied field, which is what makes it lineage rather than a claim.
   */
  generation: number
  /** The immediate predecessor's agentId. The rest of the chain is a walk of these. */
  teleportFrom?: string
  exit?: { code: number | null; summary: string; costUsd?: number }
}

export type ReplyType = Exclude<ServerMessage['t'], 'deliver' | 'error'>

/**
 * Frames a stream of newline-delimited JSON. Returned callback is fed raw chunks.
 * Malformed lines are reported rather than thrown, so one bad frame can't kill a connection.
 */
export function lineReader<T>(onValue: (value: T) => void, onError: (err: Error) => void) {
  let buffer = ''
  return (chunk: string | Buffer): void => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        onValue(JSON.parse(line) as T)
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message) + '\n'
}
