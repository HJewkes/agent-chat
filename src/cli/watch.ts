import { type ServerMessage } from '../protocol.js'
import { withBroker } from './client.js'

/**
 * `agent-chat watch <name>` — one line per message addressed to `name`.
 *
 * The delivery path for a session the broker CANNOT push to (CC-73). Claude
 * Code only accepts channel pushes from servers named on its `--channels` flag,
 * and a session started without it drops them silently, so its peers appear to
 * be ignored. Under `Monitor(persistent: true)` each line printed here becomes
 * a mid-turn notification, which is the same effect the push would have had.
 *
 * A pull, deliberately: anything relying on the broker reaching the session
 * would fail for exactly the sessions this exists to serve.
 */

/** Long enough not to hammer the broker, short enough to feel like delivery. */
const DEFAULT_INTERVAL_SEC = 2

/** Matches the broker's own per-read ceiling; it clamps anyway. */
const BATCH = 50

export interface WatchOptions {
  since?: string
  interval?: string
  once?: boolean
}

type InboxSince = Extract<ServerMessage, { t: 'inbox_since_result' }>

const poll = (name: string, afterId: number): Promise<InboxSince> =>
  withBroker(
    async b =>
      (await b.request(
        { t: 'inbox_since', name, afterId, limit: BATCH },
        'inbox_since_result',
      )) as InboxSince,
  )

/**
 * One line per message, because the line IS the notification: a watcher's
 * output is read by a model mid-turn, not scrolled by a human, so a wrapped
 * multi-line body would arrive as several unrelated events.
 */
const render = (m: InboxSince['messages'][number]): string => {
  const body = m.text.replace(/\s+/g, ' ').trim()
  const kind = m.broadcast === true ? 'broadcast' : 'from'
  return `[agent-chat] ${kind} ${m.from} (msg ${m.msgId}): ${body}`
}

/**
 * Resolve the starting cursor. `now` means "do not replay": arming a watcher on
 * a session with a backlog should not fire hundreds of notifications at once.
 * An explicit id is how a caller deliberately catches up.
 */
async function startingCursor(name: string, since: string | undefined): Promise<number> {
  if (since === undefined || since === 'now') {
    // A cursor past every possible id matches nothing, and an empty read
    // resolves to the log head — so this asks "where does the log end" using
    // the read that already exists, rather than a second round trip for it.
    const res = await poll(name, Number.MAX_SAFE_INTEGER)
    return res.nextCursor
  }
  if (since === 'all') return 0
  const parsed = Number(since)
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`--since takes a log id, "now", or "all"; got "${since}"`)
  return parsed
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function watch(name: string, options: WatchOptions = {}): Promise<void> {
  const seconds = options.interval === undefined ? DEFAULT_INTERVAL_SEC : Number(options.interval)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(`--interval takes a positive number of seconds; got "${options.interval}"`)

  let cursor = await startingCursor(name, options.since)
  for (;;) {
    // A poll that throws must not end the watch: the broker restarts when its
    // code goes stale (CC-57), and a watcher that died on that would go quiet
    // in a way indistinguishable from an empty inbox.
    try {
      const res = await poll(name, cursor)
      for (const message of res.messages) console.log(render(message))
      cursor = res.nextCursor
    } catch (error) {
      if (options.once === true) throw error
    }
    if (options.once === true) return
    await sleep(seconds * 1000)
  }
}
