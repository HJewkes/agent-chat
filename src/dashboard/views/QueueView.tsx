import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import type { QueueItem } from '../../protocol.js'
import type { QueueResponse } from '../../api-contract.js'
import { C } from '../components/shared/colors.js'
import { type as T } from '../tokens.js'
import { Badge } from '../components/shared/Badge.js'
import { relativeTime } from '../utils/formatting.js'
import { eventKindColor } from '../utils/semantic-colors.js'

interface QueueViewProps {
  queue: QueueResponse | null
}

/**
 * The human queue, READ-ONLY — and for two different reasons that must not be
 * collapsed into one.
 *
 * 1. Answer and dismiss are simply not built yet (CC-53). Temporary.
 * 2. Permission verdicts are PERMANENTLY out of scope for any UI (docs §5).
 *    The relay is observe-only by construction — the channel server declares
 *    `claude/channel/permission` and never sends a verdict back — and the
 *    dashboard must not become a backdoor around that. An `approval_request`
 *    therefore carries the same line the CLI prints: answer it in that
 *    session's own terminal. When CC-53 adds buttons, this branch keeps its
 *    notice and gets none of them.
 */
export function QueueView({ queue }: QueueViewProps) {
  const items = queue?.items ?? []

  if (queue === null) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyHint}>Loading queue…</Text>
      </View>
    )
  }

  if (items.length === 0) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyIcon}>✓</Text>
        <Text style={s.emptyTitle}>Queue is empty</Text>
        <Text style={s.emptyHint}>Nothing is waiting on you.</Text>
      </View>
    )
  }

  return (
    <View style={s.container}>
      <Text style={s.pageTitle}>
        Human Queue <Text style={s.count}>({items.length} open)</Text>
      </Text>
      <Text style={s.readOnlyNote}>Read-only in this build — answer and dismiss from the CLI.</Text>
      {items.map((item) => (
        <QueueRow key={item.msgId} item={item} />
      ))}
    </View>
  )
}

function QueueRow({ item }: { item: QueueItem }) {
  const isApproval = item.kind === 'approval_request'
  return (
    <View style={[s.row, isApproval && s.rowApproval]}>
      <View style={s.rowHeader}>
        <View style={s.rowHeaderLeft}>
          <Badge label={item.kind.replace(/_/g, ' ')} color={eventKindColor(item.kind)} dot size="sm" />
          <Text style={s.from}>{item.from}</Text>
          <Text style={s.msgId}>{item.msgId}</Text>
        </View>
        <Text style={s.age}>{relativeTime(new Date(item.at).toISOString())}</Text>
      </View>

      <Text style={s.body}>{item.text}</Text>

      {isApproval && <Text style={s.approvalNote}>Answer in that session's terminal.</Text>}

      {Object.keys(item.meta).length > 0 && (
        <View style={s.metaRow}>
          {Object.entries(item.meta).map(([k, v]) => (
            <Text key={k} style={s.metaText}>
              {k}={v}
            </Text>
          ))}
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, gap: 10 },
  pageTitle: { ...T.headingXl, color: C.textPrimary },
  count: { color: C.textTertiary, fontWeight: '400' },
  readOnlyNote: { fontSize: 12, color: C.textTertiary, marginBottom: 6, fontStyle: 'italic' },
  row: {
    backgroundColor: C.surface1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    padding: 14,
    gap: 8,
  },
  rowApproval: { borderLeftWidth: 3, borderLeftColor: C.error },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  from: { fontSize: 13, fontWeight: '600', color: C.textPrimary },
  msgId: { fontSize: 11, color: C.textTertiary, fontFamily: 'monospace' },
  age: { fontSize: 11, color: C.textTertiary },
  body: { fontSize: 13, color: C.textSecondary, lineHeight: 18 },
  approvalNote: { fontSize: 11, color: C.error, fontStyle: 'italic' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metaText: { fontSize: 10, color: C.textTertiary, fontFamily: 'monospace' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 80 },
  emptyIcon: { fontSize: 40, color: C.success },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: C.textSecondary,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  emptyHint: { fontSize: 13, color: C.textTertiary },
})
