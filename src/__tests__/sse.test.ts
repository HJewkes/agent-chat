import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_REPLAY_ROWS } from '../api-contract.js'
import { EventLog } from '../broker/event-log.js'
import type { LoggedEventRow } from '../broker/event-store.js'
import { EventHub } from '../broker/events.js'
import {
  openEventStream,
  readCursor,
  transientMessage,
  type EventFanout,
  type EventTail,
} from '../broker/sse.js'
import { HUMAN } from '../protocol.js'

/**
 * The SSE tail, tested with no port bound.
 *
 * Two behaviours here are the reason this file exists, and neither is visible by
 * reading the stream in the happy case:
 *
 * - **subscribe-then-query.** A row appended while the catch-up query is running
 *   must still arrive. Query-then-subscribe drops it silently and the stream
 *   looks perfectly healthy afterwards, so only a test that forces an append
 *   INSIDE the query can tell the two implementations apart.
 * - **the reset bound.** A gap wider than MAX_REPLAY_ROWS must produce one
 *   `reset` frame and no replay at all — a partial replay would leave the client
 *   missing the oldest rows with no way to know it.
 */

const tmpDirs: string[] = []

function makeLog(): EventLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-sse-'))
  tmpDirs.push(dir)
  return new EventLog(path.join(dir, 'events.db'))
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Drain whatever the stream has produced so far. The tail never ends on its own,
 * so "so far" is the only thing there is to assert on — the idle race uses a
 * timer rather than a resolved promise because a resolved promise is a microtask
 * and would tie with a chunk that is already queued.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const idle = new Promise<'idle'>(resolve => setTimeout(() => resolve('idle'), 0))
    const next = await Promise.race([reader.read(), idle])
    if (next === 'idle' || next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  await reader.cancel()
  return text
}

/** A tail seam over a real log, with one method swapped out. */
const tailOf = (store: EventLog, overrides: Partial<EventTail> = {}): EventTail => ({
  since: (afterId, limit) => store.since(afterId, limit),
  latestId: () => store.latestId(),
  ...overrides,
})

const frameIds = (text: string): number[] =>
  [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))

const frameEvents = (text: string): string[] =>
  [...text.matchAll(/^event: (.+)$/gm)].map(match => match[1] ?? '')

describe('readCursor', () => {
  it('prefers Last-Event-ID, which is what a browser sends by itself', () => {
    expect(readCursor('42', '7')).toBe(42)
  })

  it('falls back to ?since for clients that are not an EventSource', () => {
    expect(readCursor(null, '7')).toBe(7)
  })

  it('accepts 0, which means replay from the beginning rather than "absent"', () => {
    expect(readCursor(null, '0')).toBe(0)
  })

  it('treats an unparseable cursor as absent rather than as 0', () => {
    expect(readCursor('not-a-number', undefined)).toBeNull()
    expect(readCursor(undefined, '-5')).toBeNull()
    expect(readCursor(undefined, undefined)).toBeNull()
  })
})

describe('/events resume cursor', () => {
  it('replays exactly the rows after the cursor, oldest first', async () => {
    const store = makeLog()
    const hub = new EventHub()
    const first = store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'one' })
    store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'two' })
    store.append({ kind: 'question', actor: 'beta', target: HUMAN, body: 'three' })

    const text = await drain(openEventStream({ store, hub, cursor: first.id }))

    expect(frameIds(text)).toEqual([first.id + 1, first.id + 2])
    expect(frameEvents(text)).toEqual(['notice', 'question'])
    expect(text).toContain('"body":"two"')
  })

  it('starts from now when there is no cursor, rather than replaying the log', async () => {
    const store = makeLog()
    store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'history' })

    const text = await drain(openEventStream({ store, hub: new EventHub(), cursor: null }))

    expect(frameIds(text)).toEqual([])
  })

  it('emits one reset and no replay when the gap exceeds MAX_REPLAY_ROWS', async () => {
    const store = makeLog()
    for (let i = 0; i <= MAX_REPLAY_ROWS + 1; i += 1)
      store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: `row ${i}` })

    const text = await drain(openEventStream({ store, hub: new EventHub(), cursor: 0 }))

    expect(frameEvents(text)).toEqual(['reset'])
    expect(frameIds(text)).toEqual([])
    expect(text).toContain(`"reason":"gap_too_large","latestId":${store.latestId()}`)
  })

  it('replays rather than resetting when the gap is exactly at the bound', async () => {
    const store = makeLog()
    for (let i = 0; i < MAX_REPLAY_ROWS; i += 1)
      store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: `row ${i}` })

    const text = await drain(openEventStream({ store, hub: new EventHub(), cursor: 0 }))

    expect(frameEvents(text)).not.toContain('reset')
    expect(frameIds(text)).toHaveLength(MAX_REPLAY_ROWS)
  })
})

describe('/events live tail', () => {
  it('emits a frame for a row appended after the stream opened', async () => {
    const store = makeLog()
    const hub = new EventHub()
    const stream = openEventStream({ store, hub, cursor: null })
    const reader = stream.getReader()

    const written = store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'live' })
    hub.broadcast({ event: 'append', data: JSON.stringify({ id: written.id }) })

    const chunk = await reader.read()
    const text = new TextDecoder().decode(chunk.value)
    await reader.cancel()

    expect(frameIds(text)).toEqual([written.id])
    expect(text).toContain('"body":"live"')
  })

  it('passes a transient frame through WITHOUT an id, so the cursor cannot advance past it', async () => {
    const store = makeLog()
    const hub = new EventHub()
    const stream = openEventStream({ store, hub, cursor: null })
    const reader = stream.getReader()

    hub.broadcast(transientMessage('status'))

    const chunk = await reader.read()
    const text = new TextDecoder().decode(chunk.value)
    await reader.cancel()

    expect(text).toBe('event: session_status\ndata: {"reason":"status"}\n\n')
    expect(text).not.toContain('id:')
  })
})

describe('/events subscribe-then-query ordering', () => {
  it('subscribes to the hub BEFORE running the catch-up query', async () => {
    const store = makeLog()
    const hub = new EventHub()
    const order: string[] = []

    const observed = tailOf(store, {
      since: (afterId, limit) => {
        order.push('query')
        return store.since(afterId, limit)
      },
    })
    const spy: EventFanout = {
      subscribe: send => {
        order.push('subscribe')
        return hub.subscribe(send)
      },
    }

    await drain(openEventStream({ store: observed, hub: spy, cursor: 0 }))

    expect(order[0]).toBe('subscribe')
    expect(order).toContain('query')
  })

  /**
   * The case the ordering rule exists for. The store appends a row from inside
   * the catch-up query and broadcasts it, exactly as a live session would if it
   * happened to write mid-query. Subscribe-first delivers it once; query-first
   * would lose it entirely and report a healthy stream.
   */
  it('does not lose a row appended while the catch-up query is running', async () => {
    const store = makeLog()
    const hub = new EventHub()
    const settled = store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'before' })

    let interleaved = false
    const racy = tailOf(store, {
      since: (afterId, limit): LoggedEventRow[] => {
        const rows = store.since(afterId, limit)
        if (!interleaved) {
          interleaved = true
          const written = store.append({ kind: 'question', actor: 'beta', target: HUMAN, body: 'during' })
          hub.broadcast({ event: 'append', data: JSON.stringify({ id: written.id }) })
        }
        return rows
      },
    })

    const text = await drain(openEventStream({ store: racy, hub, cursor: settled.id - 1 }))

    // Both rows, in log order, each exactly once.
    expect(frameIds(text)).toEqual([settled.id, settled.id + 1])
    expect(text).toContain('"body":"before"')
    expect(text).toContain('"body":"during"')
  })

  it('never emits the same row twice when a live append races the replay', async () => {
    const store = makeLog()
    const hub = new EventHub()
    const first = store.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'one' })

    const stream = openEventStream({ store, hub, cursor: 0 })
    // A duplicate notification for a row the catch-up query already covered.
    hub.broadcast({ event: 'append', data: JSON.stringify({ id: first.id }) })

    const text = await drain(stream)
    expect(frameIds(text)).toEqual([first.id])
  })
})
