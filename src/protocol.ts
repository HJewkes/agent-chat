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
  'isolation_allocated',
  'isolation_released',
  // Refusals are events rather than just `reason` strings on a reply: they are
  // the security-relevant thing, and must be in the log whether or not anyone
  // was watching at the time.
  'agent_spawn_refused',
  'verdict_refused',
] as const

export type EventKind = (typeof EVENT_KINDS)[number]

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

/** Names an agent-teams isolation strategy. Widened as strategies land. */
export type IsolationName = 'none' | 'worktree' | 'file-ownership' | 'toolset-limited'

/** Where a spawned agent's process is presented. */
export type SurfaceName = 'headless' | 'iterm-pane' | 'iterm-tab' | 'iterm-window'

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
      termSessionId?: string
    }
  | { t: 'status'; status: SessionStatus; workingOn?: string; dnd?: boolean }
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
    }
  | { t: 'agents'; includeRetired?: boolean }
  | { t: 'retire'; name: string }

/** Broker -> session. */
export type ServerMessage =
  | { t: 'register_result'; ok: boolean; reason?: string }
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
 * The lifecycle an agent identity is folded into. Durable: it is a projection of
 * the event log, so it survives a broker restart in a way presence cannot.
 */
export const AGENT_LIFECYCLES = ['spawning', 'live', 'detached', 'exited', 'retired'] as const

export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number]

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
