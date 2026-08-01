import React, { useCallback, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native'
import type { QueueItem } from '../../protocol.js'
import type { QueueResponse } from '../../api-contract.js'
import { C } from '../components/shared/colors.js'
import { type as T } from '../tokens.js'
import { Badge } from '../components/shared/Badge.js'
import { relativeTime } from '../utils/formatting.js'
import { eventKindColor } from '../utils/semantic-colors.js'
import { postAnswer, postDismiss } from '../api.js'

interface QueueViewProps {
  queue: QueueResponse | null
}

/**
 * The human queue — answerable and dismissable, with ONE permanent exception.
 *
 * Permission verdicts are out of scope for any UI, forever (docs §5). The relay
 * is observe-only by construction: the channel server declares
 * `claude/channel/permission` and never sends a verdict back. An
 * `approval_request` row therefore renders with the same line the CLI prints and
 * gets no affordance at all — not a disabled one, none. If you are here to add
 * an Approve button, read docs §5 first; the answer is no.
 *
 * THE RECONCILIATION MODEL (docs §5.1). The browser is not the arbiter, the
 * broker is: `core.answer()`/`core.dismiss()` test `isOpen` and the second
 * verdict on an item loses, whichever surface it came from. So this view never
 * removes a row itself. Clicking Answer marks it pending; the row goes away when
 * the queue refetch triggered by the `answer`/`resolution` SSE frame no longer
 * contains it — the same trigger whether the verdict came from here or from
 * someone typing `agent-chat answer` in a terminal. Reconnects reconcile for free
 * through the resume cursor, because the replayed resolution drives the same
 * refetch.
 */
export function QueueView({ queue }: QueueViewProps) {
  const items = queue?.items ?? []

  /**
   * Per-row interaction state, keyed by msgId and deliberately NOT merged into
   * the item list: the list is server truth, refetched wholesale, and grafting
   * local state onto it is how optimistic removal sneaks back in. Rows that have
   * left the queue simply stop being rendered and their entry here is inert.
   */
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const setRow = useCallback((msgId: string, next: RowState) => {
    setRows(prev => ({ ...prev, [msgId]: next }))
  }, [])

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
      <Text style={s.readOnlyNote}>
        Answering here is the same write the CLI makes — rows clear when the broker says so, not when you
        click.
      </Text>
      {items.map(item => (
        <QueueRow key={item.msgId} item={item} state={rows[item.msgId] ?? IDLE} onState={setRow} />
      ))}
    </View>
  )
}

/**
 * `phase` drives the affordances; `note` is the one line shown under them.
 *
 * `pending` is not "in flight" — it outlives the response on purpose. A row stays
 * pending after a successful answer, because the row's removal is the SSE frame's
 * job and re-enabling the buttons in the gap would invite a second verdict on an
 * item that is already closed. Only a transport failure returns it to `idle`.
 */
type Phase = 'idle' | 'composing' | 'pending'

interface RowState {
  phase: Phase
  draft: string
  note: string | null
  noteIsError: boolean
}

const IDLE: RowState = { phase: 'idle', draft: '', note: null, noteIsError: false }

interface QueueRowProps {
  item: QueueItem
  state: RowState
  onState: (msgId: string, next: RowState) => void
}

function QueueRow({ item, state, onState }: QueueRowProps) {
  const isApproval = item.kind === 'approval_request'
  const set = (next: Partial<RowState>): void => onState(item.msgId, { ...state, ...next })

  /**
   * `ok: false` is not an error and must not read like one (docs §5.1 rule 3).
   * The usual cause is that the item was answered from a terminal seconds ago,
   * in which case the SSE frame that retires this row is already in flight — so
   * the row stays pending and says so inline rather than throwing up an alert
   * and re-arming buttons on something already closed. Only a fetch that fails
   * outright is a real error, and only that unwinds the pending state.
   */
  const submit = (verdict: () => Promise<{ ok: boolean; reason?: string }>): void => {
    set({ phase: 'pending', note: null, noteIsError: false })
    void verdict()
      .then(res => {
        if (res.ok) {
          onState(item.msgId, {
            ...state,
            phase: 'pending',
            note: res.reason ?? 'Recorded — waiting for the broker to close it.',
            noteIsError: false,
          })
          return
        }
        onState(item.msgId, {
          ...state,
          phase: 'pending',
          note: 'Already resolved elsewhere — this row will clear itself.',
          noteIsError: false,
        })
      })
      .catch((e: unknown) => {
        onState(item.msgId, {
          ...state,
          phase: 'idle',
          note: e instanceof Error ? e.message : String(e),
          noteIsError: true,
        })
      })
  }

  return (
    <View style={[s.row, isApproval && s.rowApproval, state.phase === 'pending' && s.rowPending]}>
      <View style={s.rowHeader}>
        <View style={s.rowHeaderLeft}>
          <Badge label={item.kind.replace(/_/g, ' ')} color={eventKindColor(item.kind)} dot size="sm" />
          <Text style={s.from}>{item.from}</Text>
          <Text style={s.msgId}>{item.msgId}</Text>
        </View>
        <Text style={s.age}>{relativeTime(new Date(item.at).toISOString())}</Text>
      </View>

      <Text style={s.body}>{item.text}</Text>

      {isApproval ? (
        <Text style={s.approvalNote}>
          Permission verdict — answer in that session's terminal. The dashboard cannot approve.
        </Text>
      ) : (
        <VerdictControls
          state={state}
          onCompose={() => set({ phase: 'composing', note: null })}
          onCancel={() => set({ phase: 'idle', draft: '', note: null })}
          onDraft={draft => set({ draft })}
          onAnswer={() => submit(() => postAnswer(item.msgId, state.draft.trim()))}
          onDismiss={() => submit(() => postDismiss(item.msgId))}
        />
      )}

      {state.note !== null && <Text style={[s.note, state.noteIsError && s.noteError]}>{state.note}</Text>}

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

interface VerdictControlsProps {
  state: RowState
  onCompose: () => void
  onCancel: () => void
  onDraft: (draft: string) => void
  onAnswer: () => void
  onDismiss: () => void
}

function VerdictControls({ state, onCompose, onCancel, onDraft, onAnswer, onDismiss }: VerdictControlsProps) {
  if (state.phase === 'pending') {
    return <Text style={s.pendingNote}>Sent — waiting for the broker to close this item…</Text>
  }

  if (state.phase === 'composing') {
    const empty = state.draft.trim() === ''
    return (
      <View style={s.compose}>
        <TextInput
          style={s.input}
          value={state.draft}
          placeholder="Your answer — routed back to the asker"
          placeholderTextColor={C.textTertiary}
          autoFocus
          onChangeText={onDraft}
          onSubmitEditing={() => {
            if (!empty) onAnswer()
          }}
        />
        <View style={s.buttons}>
          <Button label="Send" onPress={onAnswer} disabled={empty} primary />
          <Button label="Cancel" onPress={onCancel} />
        </View>
      </View>
    )
  }

  return (
    <View style={s.buttons}>
      <Button label="Answer" onPress={onCompose} primary />
      <Button label="Dismiss" onPress={onDismiss} />
    </View>
  )
}

function Button({
  label,
  onPress,
  disabled = false,
  primary = false,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.button,
        primary && s.buttonPrimary,
        disabled && s.buttonDisabled,
        pressed && !disabled && s.buttonPressed,
      ]}
    >
      <Text style={[s.buttonLabel, primary && s.buttonLabelPrimary, disabled && s.buttonLabelDisabled]}>
        {label}
      </Text>
    </Pressable>
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
  rowPending: { opacity: 0.6 },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  from: { fontSize: 13, fontWeight: '600', color: C.textPrimary },
  msgId: { fontSize: 11, color: C.textTertiary, fontFamily: 'monospace' },
  age: { fontSize: 11, color: C.textTertiary },
  body: { fontSize: 13, color: C.textSecondary, lineHeight: 18 },
  approvalNote: { fontSize: 11, color: C.error, fontStyle: 'italic' },
  note: { fontSize: 11, color: C.textTertiary },
  noteError: { color: C.error },
  pendingNote: { fontSize: 12, color: C.textTertiary, fontStyle: 'italic' },
  compose: { gap: 8 },
  input: {
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: C.textPrimary,
    outlineStyle: 'none',
  },
  buttons: { flexDirection: 'row', gap: 8 },
  button: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    cursor: 'pointer',
  },
  buttonPrimary: { borderColor: C.brand },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.4, cursor: 'default' },
  buttonLabel: { fontSize: 12, fontWeight: '600', color: C.textSecondary },
  buttonLabelPrimary: { color: C.brand },
  buttonLabelDisabled: { color: C.textTertiary },
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
