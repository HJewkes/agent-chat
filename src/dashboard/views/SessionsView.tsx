import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import type { SessionInfo } from '../../protocol.js'
import type { SessionsResponse } from '../../api-contract.js'
import { C, semantic } from '../components/shared/colors.js'
import { type as T } from '../tokens.js'
import { Badge } from '../components/shared/Badge.js'
import { TokenGauge } from '../components/shared/TokenGauge.js'
import { HorizBarList } from '../components/shared/HorizBarList.js'
import type { HorizBarRow } from '../components/shared/HorizBarList.js'
import { RankedList } from '../components/shared/RankedList.js'
import type { RankedListItem } from '../components/shared/RankedList.js'
import { LineChart } from '../components/shared/chart/LineChart.js'
import type { ChartSeries } from '../components/shared/chart/LineChart.js'
import { fmtDuration, fmtK, fmtTime } from '../utils/formatting.js'
import { dndColor, sessionStatusColor } from '../utils/semantic-colors.js'
import { branchOf, fmtIdle, sortSessions, topFilesTouched } from '../view-model.js'
import { useTranscripts } from '../transcripts.js'
import type { TranscriptEntry } from '../transcripts.js'
import { claudeSessionIdOf, fetchTranscript } from '../api.js'
import type { TranscriptAnalytics } from '../../api-contract.js'
import type { TokenSnapshot } from '../../agents/analytics/types.js'

interface SessionsViewProps {
  sessions: SessionsResponse | null
  /** Session name from the URL hash, pre-selected on mount. */
  initialSession?: string | undefined
}

type StatusFilter = 'all' | 'working' | 'available' | 'blocked'

const FILTERS: StatusFilter[] = ['all', 'working', 'available', 'blocked']

/**
 * Master/detail over the live registry, with brain's layout kept and its data
 * swapped out.
 *
 * Brain listed database session rows and could show a full event timeline for
 * each. agent-chat's list is presence — who is connected right now — and the
 * timeline is reconstructed from the transcript's `toolCalls`, which is the
 * nearest true equivalent and is the reason CC-49 ported the analytics engine.
 */
export function SessionsView({ sessions, initialSession }: SessionsViewProps) {
  const [selected, setSelected] = useState<string | null>(initialSession ?? null)
  const [filter, setFilter] = useState<StatusFilter>('all')

  const list = sessions?.sessions ?? []
  const transcripts = useTranscripts(list)

  useEffect(() => {
    if (initialSession) setSelected(initialSession)
  }, [initialSession])

  const filtered = sortSessions(list.filter(s => filter === 'all' || s.status === filter))
  const selectedSession = filtered.find(s => s.name === selected) ?? filtered[0] ?? null

  if (list.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No sessions registered</Text>
        <Text style={styles.emptyHint}>Sessions appear here once they call chat_register.</Text>
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <View style={styles.sidebar}>
        <View style={styles.sidebarHeader}>
          <Text style={styles.sidebarTitle}>Sessions</Text>
          <View style={styles.filters}>
            {FILTERS.map(f => (
              <Pressable
                key={f}
                onPress={() => setFilter(f)}
                style={[styles.filterBtn, filter === f && styles.filterBtnActive]}
              >
                <Text style={[styles.filterBtnText, filter === f && styles.filterBtnTextActive]}>{f}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <ScrollView style={styles.list}>
          {filtered.map(session => (
            <SessionRow
              key={session.name}
              session={session}
              entry={transcripts.get(session.name)}
              selected={session.name === (selectedSession?.name ?? null)}
              onPress={() => setSelected(session.name)}
            />
          ))}
        </ScrollView>
      </View>

      <View style={styles.detailPane}>
        {selectedSession ? (
          <SessionDetail session={selectedSession} />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyHint}>Select a session</Text>
          </View>
        )}
      </View>
    </View>
  )
}

function SessionRow({
  session,
  entry,
  selected,
  onPress,
}: {
  session: SessionInfo
  entry: TranscriptEntry
  selected: boolean
  onPress: () => void
}) {
  const m = entry.metrics
  return (
    <Pressable onPress={onPress} style={[styles.sessionRow, selected && styles.sessionRowSelected]}>
      <View style={styles.rowTop}>
        <Text style={styles.displayId}>{session.name}</Text>
        <Badge label={session.status} color={sessionStatusColor(session.status)} dot size="sm" />
      </View>
      <Text style={styles.rowTime}>{fmtIdle(session.idleMs)}</Text>
      <View style={styles.rowMeta}>
        <Text style={styles.metaText} numberOfLines={1}>
          {m ? `${fmtK(m.tokensIn)} in / ${fmtK(m.tokensOut)} out` : entry.loading ? '…' : 'no transcript'}
        </Text>
        {m && <Text style={styles.metaText}>{m.toolCalls} tools</Text>}
      </View>
    </Pressable>
  )
}

/**
 * The detail pane refetches the full transcript rather than reusing the list's
 * cached metrics: the card only needs counts, but this pane shows per-tool
 * breakdowns, error text and friction detail, and those are fields the summary
 * `AgentMetrics` deliberately drops.
 */
function SessionDetail({ session }: { session: SessionInfo }) {
  const [analytics, setAnalytics] = useState<TranscriptAnalytics | null>(null)
  const [notice, setNotice] = useState<string>('Loading transcript analytics…')

  useEffect(() => {
    let cancelled = false
    const sessionId = claudeSessionIdOf(session)
    setAnalytics(null)

    if (sessionId === null) {
      setNotice('No transcript analytics — this session reports no Claude Code session id')
      return
    }

    setNotice('Loading transcript analytics…')
    void fetchTranscript(sessionId, session.cwd)
      .then(res => {
        if (cancelled) return
        if (res.exists && res.analytics) {
          setAnalytics(res.analytics)
          setNotice('')
        } else {
          setNotice(`No transcript at ${res.path}`)
        }
      })
      .catch(() => {
        if (!cancelled) setNotice('Transcript analytics could not be read')
      })
    return () => {
      cancelled = true
    }
  }, [session.name, session.cwd])

  return (
    <ScrollView style={styles.detail} contentContainerStyle={styles.detailContent}>
      <View style={styles.detailHeader}>
        <Text style={styles.detailId}>{session.name}</Text>
        <Badge label={session.status} color={sessionStatusColor(session.status)} dot />
        {session.dnd && <Badge label="dnd" color={dndColor()} />}
      </View>

      <Text style={styles.workingOn}>{session.workingOn || 'No stated task'}</Text>

      <View style={styles.timestamps}>
        <FactRow label="Working dir" value={session.cwd} />
        <FactRow label="Branch" value={branchOf(session) ?? '—'} />
        <FactRow label="Registered" value={fmtTime(new Date(session.registeredAt).toISOString())} />
        <FactRow label="Idle" value={fmtIdle(session.idleMs)} />
        {session.observed?.worktreePath && (
          <FactRow
            label={session.observed.isLinkedWorktree ? 'Worktree (linked)' : 'Worktree'}
            value={session.observed.worktreePath}
          />
        )}
      </View>

      {session.declared && Object.keys(session.declared).length > 0 && (
        <View style={styles.timestamps}>
          {/* Declared presence is model-supplied — claims, not facts. Labelled so. */}
          <Text style={styles.sectionHeading}>Declared (self-reported)</Text>
          {Object.entries(session.declared).map(([k, v]) => (
            <FactRow key={k} label={k} value={v} />
          ))}
        </View>
      )}

      {session.tags && session.tags.length > 0 && (
        <View style={styles.tagRow}>
          {session.tags.map(t => (
            <Badge key={t.tag} label={`${t.tag} · by ${t.by}`} color={C.steel} size="sm" />
          ))}
        </View>
      )}

      {notice !== '' && <Text style={styles.emptyHint}>{notice}</Text>}
      {analytics && <TranscriptPanels t={analytics} />}
    </ScrollView>
  )
}

/** Snapshots are per-message; only the ends and midpoint get a readable label. */
function snapshotLabels(snapshots: TokenSnapshot[]): string[] {
  const keep = new Set([0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1])
  return snapshots.map((s, i) => (keep.has(i) ? fmtTime(new Date(s.timestamp).toISOString()) : ''))
}

function fileTouchRows(filesTouched: Record<string, string[]>, limit: number): RankedListItem[] {
  return topFilesTouched(filesTouched, limit).map(({ path, tools }) => ({
    label: path.split('/').pop() ?? path,
    sublabel: path,
    value: tools.length,
    badge: tools.join(' · '),
    color: C.brand,
  }))
}

function TranscriptPanels({ t }: { t: TranscriptAnalytics }) {
  const toolRows: HorizBarRow[] = Object.entries(t.toolCallsByName)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 12)
    .map(([label, value]) => ({ label, value, display: String(value) }))

  const snapshots = t.tokenSnapshots
  const tokenSeries: ChartSeries[] = [
    { name: 'Cumulative in', color: C.info, values: snapshots.map(s => s.cumulativeInput) },
    { name: 'Cumulative out', color: C.brand, values: snapshots.map(s => s.cumulativeOutput) },
  ]
  const files = fileTouchRows(t.filesTouched, 8)

  return (
    <>
      <View style={styles.statsRow}>
        {(
          [
            { label: 'Tokens In', value: fmtK(t.tokens.inputTokens), color: C.info },
            { label: 'Tokens Out', value: fmtK(t.tokens.outputTokens), color: C.brand },
            { label: 'Tool Calls', value: String(t.toolCalls.length), color: C.textPrimary },
            {
              label: 'Errors',
              value: String(t.errorCount),
              color: t.errorCount > 0 ? C.error : C.textTertiary,
            },
            { label: 'Duration', value: fmtDuration(t.durationMs), color: C.textSecondary },
          ] as Array<{ label: string; value: string; color: string }>
        ).map(stat => (
          <View key={stat.label} style={styles.statBox}>
            <Text style={[styles.statValue, { color: stat.color }]}>{stat.value}</Text>
            <Text style={styles.statLabel}>{stat.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.gaugeSection}>
        <TokenGauge tokensIn={t.tokens.inputTokens} tokensOut={t.tokens.outputTokens} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionHeading}>Token Growth</Text>
        <LineChart
          series={tokenSeries}
          xLabels={snapshotLabels(snapshots)}
          formatValue={v => fmtK(Math.round(v))}
          emptyText="No token snapshots recorded"
        />
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionHeading}>Tool Breakdown</Text>
        <HorizBarList rows={toolRows} emptyText="No tool calls recorded" />
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionHeading}>Files Touched</Text>
        <RankedList items={files} showBars emptyText="No files touched" />
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionHeading}>Friction Signals ({t.frictionSignals.length})</Text>
        {t.frictionSignals.length === 0 ? (
          <Text style={styles.emptyHint}>None detected</Text>
        ) : (
          t.frictionSignals.slice(0, 20).map((f, i) => (
            <View key={i} style={styles.listRow}>
              <Badge label={f.kind.replace(/_/g, ' ')} color={C.warning} size="sm" />
              <Text style={styles.listText} numberOfLines={2}>
                {f.detail}
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionHeading}>Errors ({t.errorCount})</Text>
        {t.errors.length === 0 ? (
          <Text style={styles.emptyHint}>None</Text>
        ) : (
          t.errors.slice(0, 20).map((e, i) => (
            <View key={i} style={styles.listRow}>
              <Badge label={e.toolName ?? 'error'} color={C.error} size="sm" />
              <Text style={styles.listText} numberOfLines={2}>
                {e.message}
              </Text>
            </View>
          ))
        )}
      </View>
    </>
  )
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tsRow}>
      <Text style={styles.tsLabel}>{label}</Text>
      <Text style={styles.tsValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: C.bg },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: C.textSecondary,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  emptyHint: { fontSize: 13, color: C.textTertiary },

  sidebar: {
    width: 280,
    backgroundColor: C.surface1,
    borderRightWidth: 1,
    borderRightColor: C.border,
    flexDirection: 'column',
  },
  sidebarHeader: { padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  sidebarTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: C.textPrimary,
    fontFamily: "'Space Grotesk', sans-serif",
    marginBottom: 10,
  },
  filters: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  filterBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface2,
  },
  filterBtnActive: { backgroundColor: C.brand, borderColor: C.brand },
  filterBtnText: { fontSize: 11, color: C.textTertiary, fontWeight: '500' },
  filterBtnTextActive: { color: semantic.text.inverse },
  list: { flex: 1 },

  sessionRow: { padding: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  sessionRowSelected: { borderLeftWidth: 3, borderLeftColor: C.brand, paddingLeft: 9 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  displayId: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textPrimary,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  rowTime: { fontSize: 11, color: C.textTertiary, marginBottom: 4 },
  rowMeta: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  metaText: { fontSize: 11, color: C.textSecondary },

  detailPane: { flex: 1, backgroundColor: C.bg },
  detail: { flex: 1 },
  detailContent: { padding: 24 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  detailId: { ...T.headingXl, color: C.textPrimary },
  workingOn: { fontSize: 13, color: C.textSecondary, marginBottom: 16 },
  timestamps: {
    backgroundColor: C.surface1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginBottom: 16,
    gap: 6,
  },
  tsRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  tsLabel: { fontSize: 12, color: C.textTertiary },
  tsValue: { fontSize: 12, color: C.textSecondary, fontFamily: 'monospace', flexShrink: 1 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  statBox: {
    flex: 1,
    minWidth: 110,
    backgroundColor: C.surface1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 22,
    fontWeight: '700',
    fontFamily: "'Space Grotesk', sans-serif",
    marginBottom: 2,
  },
  statLabel: { fontSize: 10, color: C.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  gaugeSection: {
    backgroundColor: C.surface1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    marginBottom: 16,
  },
  panel: {
    backgroundColor: C.surface1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    marginBottom: 16,
    gap: 8,
  },
  sectionHeading: {
    fontSize: 12,
    fontWeight: '600',
    color: C.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  listText: { flex: 1, fontSize: 11, color: C.textSecondary, lineHeight: 15 },
})
