import {
  HEARTBEAT_MS,
  MAX_REPLAY_ROWS,
  type EventFrameData,
  type ResetFrameData,
  type TransientFrameData,
} from '../api-contract.js'
import type { LoggedEventRow } from './event-store.js'
import type { SseMessage, Subscriber } from './events.js'

/**
 * `/events` — a tail of the append-only log with a resume cursor.
 *
 * The reference implementation (active-work) broadcasts a single generic
 * `change` ping from a filesystem watcher and lets the UI refetch everything,
 * because it has files rather than an event stream. We have a log with a
 * monotonic primary key, so a reconnecting browser can miss nothing: each frame
 * carries its row id as the SSE `id:`, which the browser's native `EventSource`
 * sends straight back as `Last-Event-ID` with no client bookkeeping at all.
 *
 * TWO RULES HERE ARE SUBTLE AND BOTH ARE LOAD-BEARING.
 *
 * 1. **Subscribe to the hub BEFORE running the catch-up query, never the
 *    reverse.** Anything appended between "query finished" and "subscription
 *    live" is in neither, and it is gone forever — silently, with a healthy
 *    looking stream. `openEventStream` subscribes first and only then reads.
 * 2. **A transient frame must NOT carry an `id:`.** Presence changes are
 *    in-memory and are not rows; giving them an id would advance the client's
 *    resume cursor past rows that do not exist, so the next reconnect would skip
 *    real events. A future contributor will want to add one for symmetry.
 */

/** Hub event name that `BrokerCore.append` fans out on. Anything else is transient. */
const APPEND = 'append'

/**
 * The two reads the tail needs, and nothing else.
 *
 * Narrow on purpose: `EventStore` satisfies this, but depending on the whole
 * interface would make the ordering rule above testable only through a full
 * sqlite log. A seam this small can be driven by a two-method stand-in that
 * appends from inside the query — which is the one way to tell subscribe-first
 * from query-first apart at all.
 */
export interface EventTail {
  since(afterId: number, limit: number): LoggedEventRow[]
  latestId(): number
}

/** The one thing the tail needs from the hub. `EventHub` satisfies it. */
export interface EventFanout {
  subscribe(send: Subscriber): () => void
}

export interface EventStreamOptions {
  store: EventTail
  hub: EventFanout
  /**
   * Where to resume from, or null to start from now.
   *
   * Null and 0 are NOT the same: 0 means "replay from the beginning of the log",
   * which a client can legitimately ask for with `?since=0`.
   */
  cursor: number | null
  heartbeatMs?: number
  maxReplay?: number
}

/**
 * Read the resume cursor from a request.
 *
 * `Last-Event-ID` is what a browser sends by itself. `?since=` is for everything
 * that is not an `EventSource` — curl, tests, the CLI. Anything unparseable is
 * treated as absent rather than as 0: a typo'd cursor replaying the entire log
 * is a worse answer than starting from now.
 */
export function readCursor(
  lastEventId: string | null | undefined,
  since: string | null | undefined,
): number | null {
  for (const raw of [lastEventId, since]) {
    if (raw === null || raw === undefined || raw.trim() === '') continue
    const parsed = Number.parseInt(raw, 10)
    if (Number.isInteger(parsed) && parsed >= 0) return parsed
  }
  return null
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Nothing here goes through a proxy today, but a buffering one turns a live
  // stream into a stream that delivers everything at once, at the end.
  'X-Accel-Buffering': 'no',
}

/**
 * The body of the `/events` response: an SSE stream of log rows.
 *
 * Returned as a `ReadableStream` rather than written to a socket so the whole
 * thing is exercisable through `app.fetch()` with no port bound — which is how
 * the ordering rule above actually gets tested.
 */
export function openEventStream({
  store,
  hub,
  cursor,
  heartbeatMs = HEARTBEAT_MS,
  maxReplay = MAX_REPLAY_ROWS,
}: EventStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let unsubscribe: () => void = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closed = false

  const teardown = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
    if (heartbeat !== undefined) clearInterval(heartbeat)
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // The consumer went away between our last check and this enqueue.
          teardown()
        }
      }

      // `lastSentId` is the only state that matters, and it only ever goes up.
      // Every emission path advances it, which is what makes a duplicate
      // structurally impossible rather than something we filter for.
      let lastSentId = cursor ?? store.latestId()

      /**
       * Emit every row we have not sent yet. Re-querying from `lastSentId`
       * rather than trusting the notification's payload is what collapses
       * "buffer the live frames, then drop the ones the catch-up query already
       * covered" into arithmetic: rows at or below the cursor cannot come back.
       */
      const flush = (): void => {
        if (closed) return
        const rows = store.since(lastSentId, maxReplay)
        if (rows.length === 0) return
        // One enqueue per flush rather than per row: a 500-row replay should be
        // one write, not 500.
        write(rows.map(eventFrame).join(''))
        lastSentId = rows[rows.length - 1]!.id
      }

      // RULE 1. Subscribe first. While `live` is false an append cannot be
      // emitted in order — the catch-up query is still running — so it is
      // recorded as "there is more" and picked up by the flush below.
      let live = false
      let missed = false
      unsubscribe = hub.subscribe((message: SseMessage) => {
        if (message.event !== APPEND) return write(transientFrame(message))
        if (!live) {
          missed = true
          return
        }
        flush()
      })

      // Catch-up. A gap wider than `maxReplay` is answered with `reset` rather
      // than a partial replay: a partial one leaves the client silently missing
      // the oldest rows with no way to know it.
      const latest = store.latestId()
      if (latest - lastSentId > maxReplay) {
        write(resetFrame(latest))
        lastSentId = latest
      } else {
        flush()
      }

      live = true
      if (missed) flush()

      heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs)
      // Never the reason a broker cannot exit.
      heartbeat.unref?.()
    },

    cancel() {
      teardown()
    },
  })
}

/**
 * One frame per row. `event:` is the `EventKind`, so a browser can subscribe per
 * kind — the Queue view wants `question`/`notice`/`message`/`approval_request`
 * plus `answer`/`resolution` to retire rows; the Log view wants everything.
 */
function eventFrame(row: LoggedEventRow): string {
  const data: EventFrameData = {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    actor: row.actor,
    target: row.target,
    msgId: row.msgId,
    ref: row.ref,
    body: row.body,
    meta: row.meta,
  }
  return `id: ${row.id}\nevent: ${row.kind}\ndata: ${JSON.stringify(data)}\n\n`
}

/** RULE 2: no `id:`. See the header comment — this is not an oversight. */
function transientFrame(message: SseMessage): string {
  return `event: ${message.event}\ndata: ${message.data}\n\n`
}

function resetFrame(latestId: number): string {
  const data: ResetFrameData = { reason: 'gap_too_large', latestId }
  return `event: reset\ndata: ${JSON.stringify(data)}\n\n`
}

/** Exported for the presence emitter that will feed it; see api-contract §TransientFrameData. */
export const transientMessage = (reason: TransientFrameData['reason']): SseMessage => ({
  event: 'session_status',
  data: JSON.stringify({ reason } satisfies TransientFrameData),
})
