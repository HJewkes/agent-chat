import type { Readable } from 'node:stream'

/**
 * End this MCP server when the stdio pipe carrying its session ends (CC-75).
 *
 * `StdioServerTransport` does NOT do this, despite being the obvious place for
 * it. Its `start()` attaches exactly two listeners — `data` and `error` — and
 * `onclose` is invoked from one place, inside the transport's own `close()`,
 * which the SDK calls only when the read buffer fails to parse. So stdin
 * reaching EOF fires nothing at all, and a server whose client has gone stays
 * up forever.
 *
 * Claude Code hides this by killing the subprocess outright when a session
 * ends, which is why it went unnoticed. It bites whenever the parent goes away
 * WITHOUT killing the child — a manual probe, a test harness, a crashed
 * session. Two such servers were found six days old, reparented to init, each
 * having auto-started a detached broker that then outlived it in turn.
 *
 * Both events are watched because they answer different questions and neither
 * subsumes the other: `end` is "the peer sent EOF", `close` is "the descriptor
 * is gone". A dead unix socketpair delivers one, a closed pipe the other.
 */
export interface StdinLifetime {
  stdin: Readable
  /** Run once, however many of the watched events arrive. */
  onEnd: () => void
}

export function exitWhenStdinEnds({ stdin, onEnd }: StdinLifetime): () => void {
  let fired = false
  // Deduped rather than using `once` per event: `end` and `close` normally BOTH
  // arrive for the same EOF, and tearing the broker down twice would turn one
  // orderly exit into a double close.
  const fire = (): void => {
    if (fired) return
    fired = true
    onEnd()
  }

  stdin.on('end', fire)
  stdin.on('close', fire)

  // `end` only ever fires on a stream someone is reading. The transport's own
  // `data` listener normally puts stdin in flowing mode, but that is its
  // implementation detail rather than a promise to us, and a paused stdin would
  // sit at EOF silently — which is the exact failure being fixed. Asking for it
  // directly costs nothing when it is already flowing.
  stdin.resume()

  return () => {
    stdin.off('end', fire)
    stdin.off('close', fire)
  }
}
