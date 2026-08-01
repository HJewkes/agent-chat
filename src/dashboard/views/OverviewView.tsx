import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import type { HealthPayload, HistoryResponse, QueueResponse, SessionsResponse } from '../../api-contract.js'
import { C } from '../components/shared/colors.js'
import { type as T } from '../tokens.js'
import { StatCard } from '../components/shared/StatCard.js'
import { AgentStatus } from '../components/AgentStatus.js'
import { Badge } from '../components/shared/Badge.js'
import { relativeTime } from '../utils/formatting.js'
import { eventKindColor } from '../utils/semantic-colors.js'
import { RECONNECT_GRACE_MS } from '../live.js'

interface OverviewViewProps {
  sessions: SessionsResponse | null
  queue: QueueResponse | null
  history: HistoryResponse | null
  health: HealthPayload | null
}

export function OverviewView({ sessions, queue, history, health }: OverviewViewProps) {
  const list = sessions?.sessions ?? []
  const blocked = list.filter((s) => s.status === 'blocked').length
  const approvals = (queue?.items ?? []).filter((i) => i.kind === 'approval_request').length
  const recent = (history?.items ?? []).slice(0, 12)

  return (
    <View style={s.container}>
      <View style={s.statsRow}>
        <View style={s.statSlot}>
          <StatCard label="Sessions" value={list.length} />
        </View>
        <View style={s.statSlot}>
          <StatCard label="Blocked" value={blocked} />
        </View>
        <View style={s.statSlot}>
          <StatCard label="Queue Open" value={queue?.items.length ?? 0} />
        </View>
        <View style={s.statSlot}>
          <StatCard label="Approvals" value={approvals} />
        </View>
      </View>

      {health && (
        <Text style={s.healthLine}>
          broker v{health.version} · pid {health.pid} · port {health.port ?? 'no HTTP bind'} · up{' '}
          {Math.round(health.uptime_ms / 1000)}s
        </Text>
      )}

      <View style={s.columns}>
        <View style={s.col}>
          <AgentStatus
            sessions={list}
            brokerUptimeMs={sessions?.brokerUptimeMs ?? 0}
            reconnectGraceMs={RECONNECT_GRACE_MS}
          />
        </View>
        <View style={s.col}>
          <View style={s.panel}>
            <Text style={s.sectionHeading}>Recent Events</Text>
            {recent.length === 0 ? (
              <Text style={s.emptyHint}>Nothing logged yet</Text>
            ) : (
              recent.map((item) => (
                <View key={`${item.msgId}:${item.at}:${item.kind}`} style={s.eventRow}>
                  <Badge
                    label={item.kind.replace(/_/g, ' ')}
                    color={eventKindColor(item.kind)}
                    dot
                    size="sm"
                  />
                  <Text style={s.eventText} numberOfLines={1}>
                    {item.from}: {item.text}
                  </Text>
                  <Text style={s.eventAge}>{relativeTime(new Date(item.at).toISOString())}</Text>
                </View>
              ))
            )}
          </View>
        </View>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, gap: 16 },
  statsRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  statSlot: { flex: 1, minWidth: 160 },
  healthLine: { fontSize: 11, color: C.textTertiary, fontFamily: 'monospace' },
  columns: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  col: { flex: 1, minWidth: 320 },
  panel: {
    backgroundColor: C.surface1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    padding: 16,
    gap: 8,
  },
  sectionHeading: {
    ...T.bodySm,
    color: C.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eventText: { flex: 1, fontSize: 12, color: C.textSecondary },
  eventAge: { fontSize: 10, color: C.textTertiary },
  emptyHint: { fontSize: 13, color: C.textTertiary },
})
