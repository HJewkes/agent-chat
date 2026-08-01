import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import type { SessionInfo } from '../../protocol.js'
import { Card } from './shared/Card.js'
import { Badge } from './shared/Badge.js'
import { C } from './shared/colors.js'
import { sessionStatusColor } from '../utils/semantic-colors.js'
import { branchOf, fmtIdle } from '../view-model.js'

interface AgentStatusProps {
  sessions: SessionInfo[]
  /** Under ~10s of broker uptime an empty list means "reconnecting", not "gone". */
  brokerUptimeMs: number
  reconnectGraceMs: number
}

export function AgentStatus({ sessions, brokerUptimeMs, reconnectGraceMs }: AgentStatusProps) {
  const reconnecting = sessions.length === 0 && brokerUptimeMs < reconnectGraceMs

  return (
    <Card>
      <View style={s.cardHeader}>
        <Text style={s.cardTitle}>Registered Sessions</Text>
      </View>
      <View style={s.cardContent}>
        {sessions.length === 0 ? (
          <Text style={s.emptyText}>
            {reconnecting
              ? 'Broker restarted — sessions reconnecting…'
              : 'No sessions registered'}
          </Text>
        ) : (
          sessions.map((session) => (
            <View key={session.name} style={s.agentRow}>
              <View style={s.rowTop}>
                <Text style={s.agentName}>{session.name}</Text>
                <Badge label={session.status} color={sessionStatusColor(session.status)} dot size="sm" />
              </View>
              {session.workingOn && <Text style={s.metaText}>{session.workingOn}</Text>}
              <Text style={s.metaText}>
                {branchOf(session) ?? session.cwd} · {fmtIdle(session.idleMs)}
              </Text>
            </View>
          ))
        )}
      </View>
    </Card>
  )
}

const s = StyleSheet.create({
  cardHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textPrimary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardContent: { padding: 16, gap: 8 },
  emptyText: { fontSize: 14, color: C.textTertiary },
  agentRow: {
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  agentName: { fontSize: 14, fontWeight: '600', color: C.textPrimary },
  metaText: { fontSize: 12, color: C.textSecondary, marginTop: 4 },
})
