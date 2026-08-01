import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { C, palette } from './shared/colors.js'
import { TokenGauge } from './shared/TokenGauge.js'
import { ActivitySparkline } from './shared/ActivitySparkline.js'
import type { SparkEvent } from './shared/ActivitySparkline.js'
import { Avatar } from './shared/Avatar.js'
import { Badge } from './shared/Badge.js'
import { sessionStatusColor } from '../utils/semantic-colors.js'
import { branchOf, fmtIdle } from '../view-model.js'
import type { AgentVM } from '../view-model.js'

interface Props {
  agent: AgentVM
  onPress?: () => void
}

function buildSparkEvents(toolSequence: string[]): SparkEvent[] {
  return toolSequence.slice(-15).map((type) => ({ type }))
}

/**
 * Brain's AgentCard, re-pointed at a registry session.
 *
 * The structural change from brain: metrics are a separate, optional block.
 * Brain could always render tokens and tool counts because its agents WERE
 * database rows with those columns. Here they come from a transcript that may
 * not exist, so the card renders presence unconditionally and metrics only when
 * there is something true to show.
 */
export function AgentCard({ agent, onPress }: Props) {
  const { session, metrics, notice } = agent
  const statusColor = sessionStatusColor(session.status)
  const branch = branchOf(session)
  const errRate = metrics ? (metrics.errorRate * 100).toFixed(1) : null

  return (
    <Pressable style={s.card} onPress={onPress}>
      <View style={s.header}>
        <View style={s.nameGroup}>
          <Avatar name={session.name} size={32} rounded={false} />
          <View>
            <Text style={s.name}>{session.name}</Text>
            <View style={s.badgeRow}>
              <Badge label={session.status} color={statusColor} dot size="sm" />
              {session.dnd && <Badge label="dnd" color={palette.gray.base} size="sm" />}
            </View>
          </View>
        </View>
        <Text style={s.idle}>{fmtIdle(session.idleMs)}</Text>
      </View>

      <View style={s.taskRow}>
        <Text style={s.taskText} numberOfLines={2}>
          {session.workingOn || 'No stated task'}
        </Text>
      </View>

      <View style={s.metaRow}>
        <Text style={s.metaText} numberOfLines={1}>
          {branch ? `⑂ ${branch}` : session.cwd}
        </Text>
      </View>

      {session.tags && session.tags.length > 0 && (
        <View style={s.tagRow}>
          {session.tags.map((t) => (
            <Badge key={t.tag} label={t.tag} color={C.steel} size="sm" />
          ))}
        </View>
      )}

      {metrics ? (
        <>
          <TokenGauge tokensIn={metrics.tokensIn} tokensOut={metrics.tokensOut} />
          <View style={s.metricsRow}>
            {(
              [
                ['Tool Calls', String(metrics.toolCalls), false],
                ['Errors', String(metrics.errors), metrics.errors > 0],
                ['Err Rate', `${errRate}%`, Number(errRate) > 5],
                ['Friction', String(metrics.frictionCount), metrics.frictionCount > 0],
              ] as [string, string, boolean][]
            ).map(([label, val, isErr]) => (
              <View key={label} style={s.metric}>
                <Text style={[s.metricValue, isErr && s.errorText]}>{val}</Text>
                <Text style={s.metricLabel}>{label}</Text>
              </View>
            ))}
          </View>
          <Text style={s.sparkLabel}>Recent Activity</Text>
          <ActivitySparkline events={buildSparkEvents(metrics.toolSequence)} />
        </>
      ) : (
        <Text style={s.noMetrics}>{notice}</Text>
      )}
    </Pressable>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  nameGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textPrimary,
    marginBottom: 3,
    fontFamily: "'Inter', sans-serif",
  },
  badgeRow: { flexDirection: 'row', gap: 4 },
  idle: { fontSize: 10, color: C.textTertiary },
  taskRow: {
    backgroundColor: C.surface3,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 8,
  },
  taskText: { fontSize: 11, color: C.textSecondary, lineHeight: 15 },
  metaRow: { marginBottom: 10 },
  metaText: { fontFamily: 'monospace', fontSize: 10, color: C.textTertiary },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 10 },
  metricsRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  metric: {
    flex: 1,
    backgroundColor: C.surface3,
    borderRadius: 6,
    padding: 7,
    alignItems: 'center',
  },
  metricValue: {
    fontSize: 15,
    fontWeight: '600',
    color: C.textPrimary,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  metricLabel: { fontSize: 10, color: C.textTertiary, marginTop: 2 },
  errorText: { color: C.error },
  sparkLabel: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: C.textTertiary,
    marginBottom: 4,
  },
  noMetrics: { fontSize: 11, color: C.textTertiary, fontStyle: 'italic', paddingVertical: 8 },
})
