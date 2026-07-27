// Wire protocol between a session's MCP subprocess and the shared broker.
// Newline-delimited JSON over a unix socket.

export type SessionStatus = 'working' | 'available' | 'blocked'

export interface SessionInfo {
  name: string
  workingOn: string
  cwd: string
  status: SessionStatus
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

export type EventKind =
  | 'message'
  | 'broadcast'
  | 'question'
  | 'notice'
  | 'answer'
  | 'resolution'
  | 'approval_request'
  | 'registered'
  | 'deregistered'
  | 'route_failed'

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

/** Session -> broker. */
export type ClientMessage =
  | { t: 'register'; name: string; workingOn: string; cwd: string; pid: number }
  | { t: 'status'; status: SessionStatus; workingOn?: string }
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
  /** From the terminal client, which is the human and so never registers. */
  | { t: 'human_send'; to: string; text: string }
  /** Claude Code opened a permission dialog in this session. Observed, never answered. */
  | { t: 'approval'; requestId: string; toolName: string; description: string; inputPreview: string }

/** Broker -> session. */
export type ServerMessage =
  | { t: 'register_result'; ok: boolean; reason?: string }
  | { t: 'status_result'; ok: boolean }
  | { t: 'list_result'; sessions: SessionInfo[] }
  | { t: 'send_result'; ok: boolean; msgId?: string; recipients: string[]; reason?: string }
  | { t: 'inbox_result'; messages: DeliveredMessage[] }
  | { t: 'queue_result'; items: QueueItem[] }
  | { t: 'answer_result'; ok: boolean; reason?: string }
  | { t: 'history_result'; items: QueueItem[] }
  | { t: 'deliver'; message: DeliveredMessage }
  | { t: 'error'; reason: string }

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
