import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import type { HealthPayload } from '../api-contract.js'
import { AppSidebar } from './components/shared/AppSidebar.js'
import { OverviewView } from './views/OverviewView.js'
import { AgentsView } from './views/AgentsView.js'
import { SessionsView } from './views/SessionsView.js'
import { QueueView } from './views/QueueView.js'
import { LogView } from './views/LogView.js'
import { useLiveData } from './live.js'
import { fetchHealth } from './api.js'
import { palette, sp } from './tokens.js'

type ViewId = 'overview' | 'agents' | 'sessions' | 'queue' | 'log'

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: '⌂', hash: '#overview' },
  { id: 'agents', label: 'Agents', icon: '◉', hash: '#agents' },
  { id: 'sessions', label: 'Sessions', icon: '◷', hash: '#sessions' },
  { id: 'queue', label: 'Queue', icon: '✦', hash: '#queue' },
  { id: 'log', label: 'Log', icon: '▤', hash: '#log' },
]

const VALID_VIEWS = new Set<string>(NAV_ITEMS.map((n) => n.id))

interface HashLocation {
  view: ViewId
  params: URLSearchParams
}

function parseHash(hash: string): HashLocation {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash
  const [viewPart, queryPart] = withoutHash.split('?')
  const view = (VALID_VIEWS.has(viewPart ?? '') ? viewPart : 'overview') as ViewId
  return { view, params: new URLSearchParams(queryPart ?? '') }
}

export function App() {
  const [location, setLocation] = useState<HashLocation>(() => parseHash(window.location.hash))
  const [health, setHealth] = useState<HealthPayload | null>(null)
  const { sessions, queue, history, connection, lastRefresh, error } = useLiveData()

  useEffect(() => {
    const onHashChange = () => setLocation(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])

  const handleNavSelect = useCallback((id: string) => {
    setLocation({ view: id as ViewId, params: new URLSearchParams() })
  }, [])

  const activeView = location.view
  const sessionParam = location.params.get('session') ?? undefined
  const fullBleed = activeView === 'sessions'

  return (
    <View style={styles.root}>
      <AppSidebar
        active={activeView}
        onSelect={handleNavSelect}
        navItems={NAV_ITEMS}
        projectName="agent-chat"
        generatedAt={error ?? (health ? `broker v${health.version}` : 'broker unreachable')}
        liveMode
        sseConnected={connection === 'live'}
        lastRefresh={lastRefresh}
      />

      <View style={styles.main}>
        <View style={fullBleed ? styles.contentFullBleed : styles.content}>
          {activeView === 'overview' && (
            <OverviewView sessions={sessions} queue={queue} history={history} health={health} />
          )}
          {activeView === 'agents' && <AgentsView sessions={sessions} />}
          {activeView === 'sessions' && (
            <SessionsView sessions={sessions} initialSession={sessionParam} />
          )}
          {activeView === 'queue' && <QueueView queue={queue} />}
          {activeView === 'log' && <LogView history={history} />}
        </View>
      </View>
    </View>
  )
}

const BG = palette.bg

const styles = {
  root: {
    flexDirection: 'row' as const,
    minHeight: '100vh' as unknown as number,
    backgroundColor: BG,
  },
  main: {
    flex: 1,
    backgroundColor: BG,
    overflowY: 'auto' as unknown as undefined,
    overflow: 'hidden' as unknown as undefined,
  },
  content: {
    maxWidth: 1200,
    padding: sp[12],
  },
  contentFullBleed: {
    flex: 1,
    padding: 0,
    maxWidth: undefined,
  },
}
