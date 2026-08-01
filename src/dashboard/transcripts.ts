/**
 * Transcript analytics, fetched per session and cached for the page's lifetime.
 *
 * Separate from `live.ts` on purpose. The list endpoints are cheap and refetched
 * on every event; a transcript is a whole JSONL parse — megabytes on a long
 * session — and must not be. The cache is keyed by registry session name and
 * only ever grows; `reload` is the one way to invalidate an entry.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '../protocol.js'
import { claudeSessionIdOf, fetchTranscript } from './api.js'
import { toMetrics } from './view-model.js'
import type { AgentMetrics } from './view-model.js'

export interface TranscriptEntry {
  metrics: AgentMetrics | null
  loading: boolean
  /**
   * Why there are no metrics, when there are none. `unresolvable` means we never
   * asked, because the session carries no Claude Code session id to ask about —
   * see `claudeSessionIdOf`. That is a different thing from asking and being
   * told the file does not exist, and the UI says so differently.
   */
  reason: 'ok' | 'loading' | 'unresolvable' | 'absent' | 'error'
}

export interface TranscriptStore {
  get: (name: string) => TranscriptEntry
  reload: (session: SessionInfo) => void
}

const PENDING: TranscriptEntry = { metrics: null, loading: true, reason: 'loading' }
const UNRESOLVABLE: TranscriptEntry = { metrics: null, loading: false, reason: 'unresolvable' }
const ABSENT: TranscriptEntry = { metrics: null, loading: false, reason: 'absent' }
const FAILED: TranscriptEntry = { metrics: null, loading: false, reason: 'error' }

export function useTranscripts(sessions: SessionInfo[]): TranscriptStore {
  const [entries, setEntries] = useState<Record<string, TranscriptEntry>>({})
  const requested = useRef(new Set<string>())

  const load = useCallback((session: SessionInfo) => {
    const sessionId = claudeSessionIdOf(session)
    if (sessionId === null) {
      setEntries(prev => ({ ...prev, [session.name]: UNRESOLVABLE }))
      return
    }

    setEntries(prev => ({ ...prev, [session.name]: PENDING }))
    void fetchTranscript(sessionId, session.cwd)
      .then(res => {
        setEntries(prev => ({
          ...prev,
          [session.name]:
            res.exists && res.analytics
              ? { metrics: toMetrics(res.analytics), loading: false, reason: 'ok' }
              : ABSENT,
        }))
      })
      .catch(() => setEntries(prev => ({ ...prev, [session.name]: FAILED })))
  }, [])

  const key = sessions.map(s => s.name).join(' ')
  useEffect(() => {
    for (const session of sessions) {
      if (requested.current.has(session.name)) continue
      requested.current.add(session.name)
      load(session)
    }
  }, [key, load])

  const reload = useCallback(
    (session: SessionInfo) => {
      requested.current.add(session.name)
      load(session)
    },
    [load],
  )

  const get = useCallback((name: string): TranscriptEntry => entries[name] ?? UNRESOLVABLE, [entries])

  return { get, reload }
}

/** One line explaining an entry with no metrics, for the card and the detail pane. */
export function metricsNotice(entry: TranscriptEntry): string {
  switch (entry.reason) {
    case 'loading':
      return 'Loading transcript analytics…'
    case 'unresolvable':
      return 'No transcript analytics — this session reports no Claude Code session id'
    case 'absent':
      return 'No transcript analytics — Claude Code has written no JSONL for this session'
    case 'error':
      return 'Transcript analytics could not be read'
    default:
      return ''
  }
}
