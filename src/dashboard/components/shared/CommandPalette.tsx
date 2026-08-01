import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, TextInput, StyleSheet } from 'react-native'
import { C, component } from './colors.js'
import { sp } from '../../tokens.js'
import { filterCommands } from './command-filter.js'
import type { PaletteCommand } from './command-filter.js'

export type { PaletteCommand } from './command-filter.js'

export interface CommandPaletteProps {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
  placeholder?: string
}

/**
 * Keyboard-driven command list rendered as an overlay.
 *
 * Key handling lives on `window` rather than on the input, because the
 * react-native-web shim this dashboard uses exposes no key events on
 * `TextInput` — and the palette must respond to Escape and the arrows even
 * when focus has drifted off the field.
 */
export function CommandPalette({ open, commands, onClose, placeholder = 'Search…' }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const results = useMemo(() => filterCommands(commands, query), [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
    }
  }, [open])

  const runAt = useCallback(
    (index: number) => {
      const command = results[index]
      if (!command) return
      onClose()
      command.run()
    },
    [results, onClose],
  )

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowDown') setCursor(i => Math.min(i + 1, results.length - 1))
      else if (event.key === 'ArrowUp') setCursor(i => Math.max(i - 1, 0))
      else if (event.key === 'Enter') runAt(cursor)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, results.length, cursor, onClose, runAt])

  if (!open) return null

  return (
    <View style={styles.backdrop}>
      <Pressable style={styles.backdropHit} onPress={onClose} />
      <View style={styles.panel}>
        <TextInput
          style={styles.input}
          value={query}
          placeholder={placeholder}
          placeholderTextColor={C.textTertiary}
          autoFocus
          onChangeText={text => {
            setQuery(text)
            setCursor(0)
          }}
          onSubmitEditing={() => runAt(cursor)}
        />
        <ScrollView style={styles.results}>
          {results.length === 0 ? (
            <Text style={styles.empty}>No matching commands</Text>
          ) : (
            results.map((cmd, i) => (
              <Pressable
                key={cmd.id}
                onPress={() => runAt(i)}
                onHoverIn={() => setCursor(i)}
                style={[styles.row, i === cursor && styles.rowActive]}
              >
                <Text style={[styles.rowLabel, i === cursor && styles.rowLabelActive]}>{cmd.label}</Text>
                {cmd.hint != null && <Text style={styles.rowHint}>{cmd.hint}</Text>}
              </Pressable>
            ))
          )}
        </ScrollView>
        <View style={styles.footer}>
          <Text style={styles.footerText}>↑↓ navigate · ↵ open · esc close</Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingTop: 120,
    zIndex: 1000,
  },
  backdropHit: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  panel: {
    width: 520,
    maxWidth: '90%',
    backgroundColor: C.surface1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  input: {
    paddingHorizontal: sp[10],
    paddingVertical: sp[7],
    fontSize: 14,
    color: C.textPrimary,
    backgroundColor: C.surface2,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    borderWidth: 0,
    outlineStyle: 'none',
  },
  results: { maxHeight: 320 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sp[5],
    paddingHorizontal: sp[10],
    paddingVertical: sp[6],
    cursor: 'pointer',
  },
  rowActive: { backgroundColor: component.sidebar.navActiveBg },
  rowLabel: { flex: 1, fontSize: 13, color: C.textSecondary },
  rowLabelActive: { color: C.textPrimary, fontWeight: '600' },
  rowHint: { fontSize: 11, color: C.textTertiary, fontFamily: 'monospace' },
  empty: { padding: sp[10], fontSize: 13, color: C.textTertiary },
  footer: {
    paddingHorizontal: sp[10],
    paddingVertical: sp[4],
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.surface2,
  },
  footerText: { fontSize: 10, color: C.textTertiary },
})
