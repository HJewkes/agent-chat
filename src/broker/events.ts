/**
 * Fan-out of broker-side events to connected clients, today over SSE.
 *
 * Transport-agnostic on purpose: a subscriber is just a `send` function, so the
 * hub can be wired to an SSE response, a test spy, or nothing at all. It is fed
 * from exactly one place — `BrokerCore.append` — which is what keeps the live
 * stream and the event log from drifting.
 *
 * Shape follows active-work's `src/server/events.ts`, deliberately: two of the
 * three house services already speak this interface.
 */

export interface SseMessage {
  event: string
  data: string
}

export type Subscriber = (message: SseMessage) => void | Promise<void>

export class EventHub {
  private readonly subscribers = new Set<Subscriber>()

  /** Register a subscriber; returns its unsubscribe function. */
  subscribe(send: Subscriber): () => void {
    this.subscribers.add(send)
    return () => {
      this.subscribers.delete(send)
    }
  }

  /** Connected client count, for /health and tests. */
  get size(): number {
    return this.subscribers.size
  }

  /**
   * Push to every subscriber. A slow or broken one never blocks the others and
   * never throws out of `broadcast` — a failure drops that subscriber instead,
   * so a dead connection cannot wedge every future event.
   */
  broadcast(message: SseMessage): void {
    for (const send of this.subscribers) {
      try {
        const result = send(message)
        if (result && typeof result.then === 'function') {
          result.catch(() => this.subscribers.delete(send))
        }
      } catch {
        this.subscribers.delete(send)
      }
    }
  }
}
