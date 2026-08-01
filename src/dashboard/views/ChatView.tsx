import React, { useMemo, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native'
import type { HistoryResponse } from '../../api-contract.js'
import { C } from '../components/shared/colors.js'
import { type as T, sp, radii } from '../tokens.js'
import { Avatar } from '../components/shared/Avatar.js'
import { Badge } from '../components/shared/Badge.js'
import { Pill } from '../components/shared/Pill.js'
import { fmtTime } from '../utils/formatting.js'
import { eventKindColor } from '../utils/semantic-colors.js'
import { avatarColor } from '../utils/avatar.js'
import { AgentNetworkGraph } from '../components/AgentNetworkGraph.js'
import { chatParticipants, filterChatEntries, groupChatEntries } from '../chat-feed.js'
import type { ChatEntry } from '../chat-feed.js'

interface ChatViewProps {
  history: HistoryResponse | null
}

/** Newer talk is the interesting talk; older entries stay reachable via search. */
const MAX_ENTRIES = 250

/** A message from the same sender within this gap keeps the previous avatar. */
const GROUPING_GAP_MS = 120_000

const COLLAPSED_LINES = 10

/** Agent-to-agent traffic as a chat transcript, oldest first. */
export function ChatView({ history }: ChatViewProps) {
  const [agents, setAgents] = useState<string[]>([])
  const [query, setQuery] = useState('')

  const entries = useMemo(() => groupChatEntries(history?.items ?? []), [history])
  const participants = useMemo(() => chatParticipants(entries), [entries])
  const visible = filterChatEntries(entries, { agents, query }).slice(-MAX_ENTRIES)

  const toggleAgent = (name: string) =>
    setAgents(current => (current.includes(name) ? current.filter(a => a !== name) : [...current, name]))

  if (history === null) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyHint}>Loading conversation…</Text>
      </View>
    )
  }

  return (
    <View style={s.container}>
      <Text style={s.pageTitle}>Chat</Text>
      <AgentNetworkGraph items={history.items} entries={entries} />
      <FilterBar
        participants={participants}
        selected={agents}
        query={query}
        onToggleAgent={toggleAgent}
        onQuery={setQuery}
        onClear={() => setAgents([])}
      />
      <Text style={s.count}>
        {visible.length} of {entries.length} messages
      </Text>
      <View style={s.feed}>
        {visible.length === 0 && <Text style={s.emptyHint}>Nothing matches yet.</Text>}
        {visible.map((entry, i) => (
          <Bubble
            key={entry.msgId + entry.at}
            entry={entry}
            grouped={continuesThread(visible[i - 1], entry)}
          />
        ))}
      </View>
    </View>
  )
}

/** Only a same-sender, same-audience run collapses; a new audience needs its chips. */
function continuesThread(previous: ChatEntry | undefined, entry: ChatEntry): boolean {
  if (!previous || previous.from !== entry.from) return false
  if (previous.recipients.join() !== entry.recipients.join()) return false
  return entry.at - previous.at < GROUPING_GAP_MS
}

interface FilterBarProps {
  participants: string[]
  selected: string[]
  query: string
  onToggleAgent: (name: string) => void
  onQuery: (text: string) => void
  onClear: () => void
}

function FilterBar({ participants, selected, query, onToggleAgent, onQuery, onClear }: FilterBarProps) {
  return (
    <View style={s.filterBar}>
      <TextInput
        style={s.search}
        value={query}
        placeholder="Search messages…"
        placeholderTextColor={C.textTertiary}
        onChangeText={onQuery}
      />
      <View style={s.agentChips}>
        <Pressable onPress={onClear} style={[s.chip, selected.length === 0 && s.chipActive]}>
          <Text style={[s.chipText, selected.length === 0 && s.chipTextActive]}>everyone</Text>
        </Pressable>
        {participants.map(name => {
          const on = selected.includes(name)
          return (
            <Pressable key={name} onPress={() => onToggleAgent(name)} style={[s.chip, on && s.chipActive]}>
              <View style={[s.chipDot, { backgroundColor: avatarColor(name) }]} />
              <Text style={[s.chipText, on && s.chipTextActive]}>{name}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

function Bubble({ entry, grouped }: { entry: ChatEntry; grouped: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const accent = avatarColor(entry.from)

  return (
    <View style={[s.row, grouped && s.rowGrouped]}>
      <View style={s.gutter}>{!grouped && <Avatar name={entry.from} size={28} />}</View>
      <View style={s.stack}>
        {!grouped && (
          <View style={s.header}>
            <Text style={[s.sender, { color: accent }]}>{entry.from}</Text>
            <Text style={s.arrow}>→</Text>
            <AudienceChips entry={entry} />
            <Text style={s.time}>{fmtTime(new Date(entry.at).toISOString())}</Text>
          </View>
        )}
        <Pressable onPress={() => setExpanded(v => !v)}>
          <View style={[s.bubble, { borderLeftColor: accent }]}>
            <Text style={s.body} numberOfLines={expanded ? undefined : COLLAPSED_LINES}>
              {entry.text}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  )
}

function AudienceChips({ entry }: { entry: ChatEntry }) {
  const kindChip = entry.kind !== 'message' && entry.kind !== 'broadcast' && (
    <Badge label={entry.kind} color={eventKindColor(entry.kind)} dot size="sm" />
  )

  if (entry.scope === 'broadcast') {
    return (
      <View style={s.chipRow}>
        <Pill label="all" bg={C.surface3} borderColor={C.border} color={C.warning} size="sm" />
      </View>
    )
  }
  if (entry.scope === 'tag') {
    return (
      <View style={s.chipRow}>
        <Pill label={`#${entry.tag}`} bg={C.surface3} borderColor={C.border} color={C.info} size="sm" />
      </View>
    )
  }

  return (
    <View style={s.chipRow}>
      {entry.recipients.map(name => (
        <Pill
          key={name}
          label={name}
          bg={C.surface3}
          borderColor={C.border}
          color={C.textSecondary}
          size="sm"
        />
      ))}
      {kindChip}
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, gap: sp[6] },
  pageTitle: { ...T.headingXl, color: C.textPrimary },
  filterBar: { gap: sp[5] },
  search: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: radii.md,
    backgroundColor: C.surface2,
    color: C.textPrimary,
    paddingHorizontal: sp[6],
    paddingVertical: sp[5],
    fontSize: 13,
    maxWidth: 420,
  },
  agentChips: { flexDirection: 'row', flexWrap: 'wrap', gap: sp[2] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sp[3],
    paddingHorizontal: sp[5],
    paddingVertical: sp[2],
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface2,
  },
  chipActive: { backgroundColor: C.brand, borderColor: C.brand },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: 11, color: C.textTertiary, fontWeight: '500' },
  chipTextActive: { color: C.textPrimary },
  count: { fontSize: 11, color: C.textTertiary },
  feed: { gap: sp[6], paddingBottom: sp[12] },
  row: { flexDirection: 'row', gap: sp[5], alignItems: 'flex-start' },
  rowGrouped: { marginTop: -sp[4] },
  gutter: { width: 28 },
  stack: { flex: 1, gap: sp[2], maxWidth: 820 },
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: sp[3] },
  sender: { ...T.headingSm },
  arrow: { fontSize: 11, color: C.textTertiary },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: sp[2] },
  time: { fontSize: 10, color: C.textTertiary, fontFamily: 'monospace' },
  bubble: {
    backgroundColor: C.surface1,
    borderWidth: 1,
    borderColor: C.border,
    borderLeftWidth: 3,
    borderRadius: radii.lg,
    paddingHorizontal: sp[6],
    paddingVertical: sp[5],
  },
  body: { fontSize: 12.5, lineHeight: 19, color: C.textSecondary, whiteSpace: 'pre-wrap' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyHint: { fontSize: 13, color: C.textTertiary },
})
