/**
 * Liveness: one SSE subscription, one poll fallback, one refetch.
 *
 * V1 deliberately does NOT apply frames incrementally. Every frame — whatever
 * its kind — means "the read model moved", and the answer is to refetch the
 * three list endpoints. That is the same thing active-work's dashboard does
 * with its single `change` ping, and it is correct here for a reason worth
 * writing down: `/api/queue` is a derived view (open items only, with the
 * CLOSED subquery deciding what "open" means), so reconstructing it client-side
 * from an `answer` or `resolution` frame would mean reimplementing that
 * subquery in the browser and keeping the two in step. Refetching cannot drift.
 *
 * Applying frames incrementally is a real optimisation, just not one V1 needs
 * at a few dozen rows. TODO(CC-53): revisit when the queue view gains write
 * affordances, since that is when optimistic-vs-authoritative state starts to
 * matter (docs §5.1 rule 1: no optimistic removal).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { SSE_EVENT_NAMES } from '../api-contract.js'
import type { HistoryResponse, QueueResponse, SessionsResponse } from '../api-contract.js'
import { API_BASE, fetchHistory, fetchQueue, fetchSessions } from './api.js'

/** How often to refetch when SSE is not connected. */
const POLL_MS = 5_000

/** Coalescing window for bursts of frames — a spawn emits several at once. */
const REFETCH_DEBOUNCE_MS = 250

/**
 * Below this uptime an empty session list is not evidence that anything died.
 * Registration is a lease held by a live socket and the registry is in-memory,
 * so a fresh broker is legitimately empty while clients climb the reconnect
 * ladder — see the `brokerUptimeMs` note in api-contract.ts.
 */
export const RECONNECT_GRACE_MS = 10_000

export type ConnectionState = 'connecting' | 'live' | 'polling'

export interface LiveData {
  sessions: SessionsResponse | null
  queue: QueueResponse | null
  history: HistoryResponse | null
  connection: ConnectionState
  lastRefresh: Date | null
  error: string | null
  refetch: () => void
}

export function useLiveData(): LiveData {
  const [sessions, setSessions] = useState<SessionsResponse | null>(null)
  const [queue, setQueue] = useState<QueueResponse | null>(null)
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refetch = useCallback(() => {
    void Promise.all([fetchSessions(), fetchQueue(), fetchHistory()])
      .then(([s, q, h]) => {
        setSessions(s)
        setQueue(q)
        setHistory(h)
        setLastRefresh(new Date())
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const scheduleRefetch = useCallback(() => {
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(refetch, REFETCH_DEBOUNCE_MS)
  }, [refetch])

  useEffect(() => {
    refetch()

    // EventSource cannot set headers, so the loopback token rides the query
    // string when the broker injected one (docs §6.5).
    const token = window.__AGENT_CHAT_TOKEN__
    const url = `${API_BASE}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const es = new EventSource(url)

    es.onopen = () => setConnection('live')
    es.onerror = () => setConnection('polling')
    for (const name of SSE_EVENT_NAMES) es.addEventListener(name, scheduleRefetch)

    // Runs regardless of SSE health and is the fallback by itself: while the
    // stream is up this is a cheap no-op refresh, and when it is down it is the
    // only thing keeping the page current.
    const poll = setInterval(() => {
      if (connectionIsDown(es)) refetch()
    }, POLL_MS)

    return () => {
      for (const name of SSE_EVENT_NAMES) es.removeEventListener(name, scheduleRefetch)
      es.close()
      clearInterval(poll)
      if (pending.current) clearTimeout(pending.current)
    }
  }, [refetch, scheduleRefetch])

  return { sessions, queue, history, connection, lastRefresh, error, refetch }
}

function connectionIsDown(es: EventSource): boolean {
  return es.readyState !== EventSource.OPEN
}
