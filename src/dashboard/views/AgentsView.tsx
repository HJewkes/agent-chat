import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import type { SessionsResponse } from '../../api-contract.js'
import { C } from '../components/shared/colors.js'
import { type as T } from '../tokens.js'
import { AgentCard } from '../components/AgentCard.js'
import { fmtK } from '../utils/formatting.js'
import { metricsNotice, useTranscripts } from '../transcripts.js'
import { isLive, sortSessions } from '../view-model.js'
import type { AgentVM } from '../view-model.js'
import { RECONNECT_GRACE_MS } from '../live.js'

interface AgentsViewProps {
  sessions: SessionsResponse | null
}

/**
 * Brain's AgentsView, minus its Topology and Costs tabs.
 *
 * Topology drew a coordinator-over-workers tree by assuming `agents[0]` was the
 * coordinator — an assumption agent-chat can actually answer properly, since
 * `agent_spawned` records real parentage in the event log. Drawing the fake tree
 * here would be worse than not drawing it, so it is out until the real edges are
 * wired. Costs is gone outright: nothing in this repo prices a token.
 */
export function AgentsView({ sessions }: AgentsViewProps) {
  const list = sessions?.sessions ?? []
  const transcripts = useTranscripts(list)

  const agents: AgentVM[] = sortSessions(list).map((session) => {
    const entry = transcripts.get(session.name)
    return { session, metrics: entry.metrics, notice: metricsNotice(entry) }
  })

  if (sessions === null) return <Loading />
  if (agents.length === 0) return <EmptyState brokerUptimeMs={sessions.brokerUptimeMs} />

  return (
    <View style={s.container}>
      <StatsBar agents={agents} />
      <View style={s.cardsGrid}>
        {agents.map((agent) => (
          <View key={agent.session.name} style={s.cardSlot}>
            <AgentCard
              agent={agent}
              onPress={() => {
                window.location.hash = `#sessions?session=${encodeURIComponent(agent.session.name)}`
              }}
            />
          </View>
        ))}
      </View>
    </View>
  )
}

function StatsBar({ agents }: { agents: AgentVM[] }) {
  const live = agents.filter((a) => isLive(a.session)).length
  const blocked = agents.filter((a) => a.session.status === 'blocked').length
  const withMetrics = agents.filter((a) => a.metrics !== null)
  const totalTokens = withMetrics.reduce((n, a) => n + a.metrics!.tokensIn + a.metrics!.tokensOut, 0)
  const totalTools = withMetrics.reduce((n, a) => n + a.metrics!.toolCalls, 0)
  const totalErrors = withMetrics.reduce((n, a) => n + a.metrics!.errors, 0)
  const errRate = totalTools > 0 ? ((totalErrors / totalTools) * 100).toFixed(1) : '0.0'

  const stats: [string, string, string][] = [
    ['Sessions', String(agents.length), C.textPrimary],
    ['Working', String(live - blocked), C.success],
    ['Blocked', String(blocked), blocked > 0 ? C.error : C.textTertiary],
    ['Tokens', fmtK(totalTokens), C.info],
    ['Tool Calls', fmtK(totalTools), C.success],
    ['Error Rate', `${errRate}%`, totalErrors > 0 ? C.error : C.textTertiary],
  ]

  return (
    <View style={s.statsBar}>
      {stats.map(([label, value, color]) => (
        <View key={label} style={s.statCard}>
          <Text style={s.statLabel}>{label}</Text>
          <Text style={[s.statValue, { color }]}>{value}</Text>
        </View>
      ))}
    </View>
  )
}

function Loading() {
  return (
    <View style={s.emptyState}>
      <Text style={s.emptySubtitle}>Loading sessions…</Text>
    </View>
  )
}

/**
 * The empty list is ambiguous and the uptime disambiguates it. Registration is a
 * lease held by a live socket, so a broker that restarted seconds ago is
 * legitimately empty — telling the user every session died would be a lie the
 * data does not support. See the `brokerUptimeMs` note in api-contract.ts.
 */
function EmptyState({ brokerUptimeMs }: { brokerUptimeMs: number }) {
  const reconnecting = brokerUptimeMs < RECONNECT_GRACE_MS
  return (
    <View style={s.emptyState}>
      <Text style={s.emptyIcon}>○</Text>
      <Text style={s.emptyTitle}>{reconnecting ? 'Broker restarted' : 'No sessions registered'}</Text>
      <Text style={s.emptySubtitle}>
        {reconnecting
          ? 'Sessions are reconnecting — this list fills in over the next few seconds.'
          : 'Sessions appear here once they call chat_register.'}
      </Text>
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  statsBar: { flexDirection: 'row', gap: 10, marginBottom: 20, flexWrap: 'wrap' },
  statCard: {
    flex: 1,
    minWidth: 90,
    backgroundColor: C.surface1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    padding: 14,
  },
  statLabel: {
    fontSize: 10,
    color: C.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  statValue: { ...T.heading2xl },
  cardsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  cardSlot: { width: '31%' as unknown as number, minWidth: 280, flex: 1 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 8 },
  emptyIcon: { fontSize: 48, color: C.textTertiary },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: C.textSecondary,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  emptySubtitle: { fontSize: 13, color: C.textTertiary, textAlign: 'center', maxWidth: 380 },
})
