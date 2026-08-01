import React, { useMemo, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import type { QueueItem } from '../../protocol.js'
import type { HistoryResponse } from '../../api-contract.js'
import { C } from '../components/shared/colors.js'
import { type as T } from '../tokens.js'
import { Badge } from '../components/shared/Badge.js'
import { DataTable } from '../components/shared/DataTable.js'
import type { DataTableColumn } from '../components/shared/DataTable.js'
import { fmtTimestampLong, relativeTime } from '../utils/formatting.js'
import { eventKindColor } from '../utils/semantic-colors.js'

interface LogViewProps {
  history: HistoryResponse | null
}

const COLUMNS: DataTableColumn[] = [
  { key: 'when', label: 'When', width: 150 },
  { key: 'kind', label: 'Kind', width: 130 },
  { key: 'from', label: 'From', width: 130 },
  { key: 'text', label: 'Body', flex: 1 },
]

/** The event log, newest first, filterable by kind. */
export function LogView({ history }: LogViewProps) {
  const items = history?.items ?? []
  const [kindFilter, setKindFilter] = useState<string>('all')

  const kinds = useMemo(() => ['all', ...Array.from(new Set(items.map(i => i.kind))).sort()], [items])
  const filtered = items.filter(i => kindFilter === 'all' || i.kind === kindFilter)

  if (history === null) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyHint}>Loading history…</Text>
      </View>
    )
  }

  return (
    <View style={s.container}>
      <Text style={s.pageTitle}>Event Log</Text>
      <View style={s.filters}>
        {kinds.map(k => (
          <Pressable
            key={k}
            onPress={() => setKindFilter(k)}
            style={[s.filterBtn, kindFilter === k && s.filterBtnActive]}
          >
            <Text style={[s.filterText, kindFilter === k && s.filterTextActive]}>{k}</Text>
          </Pressable>
        ))}
      </View>

      <DataTable<QueueItem>
        columns={COLUMNS}
        data={filtered}
        getKey={item => `${item.msgId}:${item.at}:${item.kind}`}
        emptyText="No events recorded"
        renderCell={(item, key) => <Cell item={item} columnKey={key} />}
      />
    </View>
  )
}

function Cell({ item, columnKey }: { item: QueueItem; columnKey: string }) {
  const iso = new Date(item.at).toISOString()
  switch (columnKey) {
    case 'when':
      return (
        <View>
          <Text style={s.cellMono}>{fmtTimestampLong(iso)}</Text>
          <Text style={s.cellDim}>{relativeTime(iso)}</Text>
        </View>
      )
    case 'kind':
      return <Badge label={item.kind.replace(/_/g, ' ')} color={eventKindColor(item.kind)} dot size="sm" />
    case 'from':
      return <Text style={s.cellText}>{item.from}</Text>
    default:
      return (
        <Text style={s.cellText} numberOfLines={2}>
          {item.text}
        </Text>
      )
  }
}

const s = StyleSheet.create({
  container: { flex: 1, gap: 12 },
  pageTitle: { ...T.headingXl, color: C.textPrimary },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4 },
  filterBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface2,
  },
  filterBtnActive: { backgroundColor: C.brand, borderColor: C.brand },
  filterText: { fontSize: 11, color: C.textTertiary, fontWeight: '500' },
  filterTextActive: { color: C.textPrimary },
  cellMono: { fontSize: 11, color: C.textSecondary, fontFamily: 'monospace' },
  cellDim: { fontSize: 10, color: C.textTertiary },
  cellText: { fontSize: 12, color: C.textSecondary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyHint: { fontSize: 13, color: C.textTertiary },
})
