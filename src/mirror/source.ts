import { ITEM_KINDS, type ItemKind, type Verdict } from '@titan-design/matrix-bus'
import type {
  QueueItem,
  QueueSource,
  ResolveResult,
  SourceEvent,
  VerdictInput,
} from '@titan-design/queue-mirror'
import {
  TOKEN_HEADER,
  type EventFrameData,
  type QueueResponse,
  type ResetFrameData,
} from '../api-contract.js'
import { APPROVAL_TTL_MS } from '../broker/event-log.js'
import { HUMAN, type ClientMessage, type EventKind, type ServerMessage } from '../protocol.js'
import { readSseFrames } from './sse-reader.js'

/**
 * agent-chat's `QueueSource` adapter (CC-145 S1): reads `/api/queue` and tails
 * `/events`, and resolves verdicts over one unregistered `BrokerClient`
 * connection. `runMirror` itself (queue-mirror, not shipped in 0.1.0) is what
 * drives this; nothing here talks to Matrix.
 */

export interface AgentChatSourceOptions {
  /** `TitanItem.machine`, e.g. `'edge1'`. */
  machine: string
  /** `http://127.0.0.1:<port>`, re-read from `broker.meta.json` on every connect. */
  baseUrl: () => string | null
  /** Re-read from the `ui.token` file on every connect. */
  token: () => string | null
  /** One unregistered socket connection; permissions never go over HTTP. */
  verdicts: VerdictChannel
  /** Tests inject a fake. */
  fetch?: typeof fetch
}

/** `BrokerClient` satisfies this; tests pass a fake. */
export interface VerdictChannel {
  request(message: ClientMessage, replyType: 'answer_result'): Promise<ServerMessage>
}

/** The common shape of a row read from `/api/queue` and one parsed off `/events`. */
export interface QueueRow {
  msgId: string
  kind: EventKind
  from: string
  text: string
  at: number
  meta: Record<string, string>
}

export function agentChatQueueSource(options: AgentChatSourceOptions): QueueSource {
  return {
    kinds: ITEM_KINDS,
    open: () => openQueue(options),
    tail: (cursor, signal) => tail(options, cursor, signal),
    resolve: (id, verdict) => resolve(options, id, verdict),
  }
}

function isItemKind(kind: EventKind): kind is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(kind)
}

/** Used by both `open()` (rows off `/api/queue`) and `tail()` (rows parsed off `/events`). No truncation here. */
export function toQueueItem(row: QueueRow, machine: string): QueueItem | null {
  if (!isItemKind(row.kind)) return null
  const item: QueueItem = {
    id: row.msgId,
    kind: row.kind,
    machine,
    session: row.from,
    at: row.at,
    text: row.text,
  }
  if (row.kind === 'endorse_request') {
    if (row.meta['recipient'] !== undefined) item.recipient = row.meta['recipient']
    if (row.meta['agent_id'] !== undefined) item.agentId = row.meta['agent_id']
  } else if (row.kind === 'approval_request') {
    if (row.meta['tool_name'] !== undefined) item.toolName = row.meta['tool_name']
    if (row.meta['input_preview'] !== undefined) item.inputPreview = row.meta['input_preview']
    if (row.meta['source'] !== 'hook') item.expiresAt = row.at + APPROVAL_TTL_MS
  }
  return item
}

/** `opened` mirrors `humanQueue()`'s filter; `closed` reads an `answer`/`resolution` row's `ref`. Anything else is null. */
export function toSourceEvent(frame: EventFrameData, machine: string): SourceEvent | null {
  const cursor = String(frame.id)
  if (isItemKind(frame.kind) && frame.target === HUMAN) {
    const row: QueueRow = {
      msgId: frame.msgId ?? String(frame.id),
      kind: frame.kind,
      from: frame.actor,
      text: frame.body ?? '',
      at: frame.ts,
      meta: frame.meta,
    }
    const item = toQueueItem(row, machine)
    return item ? { type: 'opened', item, cursor } : null
  }
  if ((frame.kind === 'answer' || frame.kind === 'resolution') && frame.ref !== null) {
    const outcome = frame.body === 'withdrawn' ? 'cancelled' : 'resolved'
    const label = frame.kind === 'answer' ? 'answered' : frame.body
    return label === null
      ? { type: 'closed', id: frame.ref, outcome, cursor }
      : { type: 'closed', id: frame.ref, outcome, label, cursor }
  }
  return null
}

export function toClientFrame(id: string, verdict: VerdictInput): ClientMessage {
  const behavior = verdict.verdict as Verdict
  if (behavior === 'allow' || behavior === 'deny') return { t: 'approve_permission', msgId: id, behavior }
  if (behavior === 'approve') return { t: 'endorse_approve', msgId: id }
  if (behavior === 'answer') return { t: 'answer', msgId: id, text: verdict.text ?? '' }
  return { t: 'dismiss', msgId: id }
}

const CLOSED_REASON = /is not an open|no item with id|has no hook waiting/

export function toResolveResult(reply: Extract<ServerMessage, { t: 'answer_result' }>): ResolveResult {
  if (reply.ok) return { ok: true }
  const reason = reply.reason ?? ''
  if (CLOSED_REASON.test(reason)) return { ok: false, reason: 'closed' }
  return { ok: false, reason: 'rejected', detail: reason }
}

async function openQueue(options: AgentChatSourceOptions): Promise<QueueItem[]> {
  const baseUrl = options.baseUrl()
  if (!baseUrl) throw new Error('agent-chat broker is not running (no baseUrl)')
  const fetchImpl = options.fetch ?? fetch
  const res = await fetchImpl(`${baseUrl}/api/queue`, { headers: authHeaders(options) })
  if (!res.ok) throw new Error(`GET /api/queue failed: ${res.status}`)
  const body = (await res.json()) as QueueResponse
  const items: QueueItem[] = []
  for (const row of body.items) {
    const item = toQueueItem(row, options.machine)
    if (item) items.push(item)
  }
  return items
}

async function resolve(
  options: AgentChatSourceOptions,
  id: string,
  verdict: VerdictInput,
): Promise<ResolveResult> {
  const reply = await options.verdicts.request(toClientFrame(id, verdict), 'answer_result')
  if (reply.t !== 'answer_result') throw new Error(`unexpected reply "${reply.t}" for answer_result`)
  return toResolveResult(reply)
}

function authHeaders(options: AgentChatSourceOptions): Record<string, string> {
  const token = options.token()
  return token ? { [TOKEN_HEADER]: token } : {}
}

/**
 * `tail()` connects eagerly rather than as an `async function*`: `runMirror`
 * calls it before `reconcile()`, so a lazy generator would reopen the gap that
 * elapses during reconcile. Returning an `EventChannel` lets the fetch start
 * synchronously while the body is pumped in the background.
 */
function tail(
  options: AgentChatSourceOptions,
  cursor: string | undefined,
  signal: AbortSignal,
): AsyncIterable<SourceEvent> {
  const channel = new EventChannel()
  const baseUrl = options.baseUrl()
  if (!baseUrl) {
    channel.fail(new Error('agent-chat broker is not running (no baseUrl)'))
    return channel
  }
  const headers = authHeaders(options)
  if (cursor !== undefined) headers['Last-Event-ID'] = cursor
  const fetchImpl = options.fetch ?? fetch
  const request = fetchImpl(`${baseUrl}/events`, { headers, signal })
  void pumpTail(request, options, channel, signal)
  return channel
}

async function pumpTail(
  request: Promise<Response>,
  options: AgentChatSourceOptions,
  channel: EventChannel,
  signal: AbortSignal,
): Promise<void> {
  try {
    const res = await request
    if (!res.ok || !res.body) throw new Error(`GET /events failed: ${res.status}`)
    for await (const frame of readSseFrames(res.body)) {
      if (frame.event === 'reset') return handleReset(frame, options, channel)
      if (frame.id === undefined) continue
      const event = toSourceEvent(JSON.parse(frame.data) as EventFrameData, options.machine)
      if (event) channel.push(event)
    }
    if (!signal.aborted) channel.fail(new Error('sse stream ended'))
    else channel.end()
  } catch (err) {
    if (signal.aborted) channel.end()
    else channel.fail(err)
  }
}

/**
 * Sent instead of a replay when the gap exceeds `MAX_REPLAY_ROWS`. Reconciling
 * from `open()` recovers what is still open; the sentinel `closed` commits the
 * cursor past the gap with no id `applySourceEvent` will ever match, then the
 * throw restarts the source loop so `reconcile()` closes anything that shut
 * during the gap.
 */
async function handleReset(
  frame: { data: string },
  options: AgentChatSourceOptions,
  channel: EventChannel,
): Promise<void> {
  const reset = JSON.parse(frame.data) as ResetFrameData
  const cursor = String(reset.latestId)
  for (const item of await openQueue(options)) channel.push({ type: 'opened', item, cursor })
  channel.push({ type: 'closed', id: '__reset__', outcome: 'resolved', cursor })
  channel.fail(new Error('sse reset'))
}

/** A single-consumer async queue: `push`/`fail`/`end` from the pump, iterated by the caller. */
class EventChannel implements AsyncIterable<SourceEvent> {
  private readonly queue: SourceEvent[] = []
  private readonly waiting: Array<{
    resolve: (result: IteratorResult<SourceEvent>) => void
    reject: (err: unknown) => void
  }> = []
  private closed = false
  private error: unknown

  push(event: SourceEvent): void {
    const waiter = this.waiting.shift()
    if (waiter) waiter.resolve({ value: event, done: false })
    else this.queue.push(event)
  }

  fail(err: unknown): void {
    this.closed = true
    this.error = err
    for (const waiter of this.waiting.splice(0)) waiter.reject(err)
  }

  end(): void {
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SourceEvent> {
    return {
      next: (): Promise<IteratorResult<SourceEvent>> => {
        const queued = this.queue.shift()
        if (queued) return Promise.resolve({ value: queued, done: false })
        if (this.closed)
          return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }))
      },
    }
  }
}
