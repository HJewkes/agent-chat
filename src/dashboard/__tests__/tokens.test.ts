import { describe, expect, it } from 'vitest'
import {
  categoricalPalette,
  getSemanticColors,
  greyRamp,
  primitiveColors,
} from '@titan-design/react-ui/theme/tokens'
import { colors, palette, semantic } from '../tokens.js'
import { dndColor, eventKindColor, sessionStatusColor } from '../utils/semantic-colors.js'

const T = getSemanticColors('dark')

describe('dashboard tokens resolve from titan-design', () => {
  it('takes brand, surfaces and text from titan semantic tokens', () => {
    expect(semantic.accent).toBe(T['brand-primary'])
    expect(semantic.surface.page).toBe(T['background-base'])
    expect(semantic.surface.card).toBe(T['surface-elevated'])
    expect(semantic.border).toBe(T['hairline-default'])
    expect(semantic.text.primary).toBe(T['text-primary'])
  })

  it('uses the on-brand token for text sitting on a brand fill, not text-inverse', () => {
    expect(semantic.text.inverse).toBe(T['on-brand-primary'])
    expect(semantic.text.inverse).not.toBe(T['text-inverse'])
  })

  it('leaves no hex outside titan’s token set in the exported values', () => {
    const titanValues = [T, primitiveColors, greyRamp, categoricalPalette].flatMap(flatten)
    const strays = flatten(palette)
      .concat(flatten(semantic), flatten(colors))
      .filter(v => v.startsWith('#'))
      .filter(v => !titanValues.includes(v))
    expect(strays).toEqual([])
  })
})

describe('session status colours', () => {
  it('maps each session status onto its titan status token', () => {
    expect(sessionStatusColor('working')).toBe(T['status-live'])
    expect(sessionStatusColor('available')).toBe(T['status-live-muted'])
    expect(sessionStatusColor('blocked')).toBe(T['status-error'])
  })

  it('keeps working and available visually distinct', () => {
    // titan resolves status-live and status-success to the same green, so
    // mapping `available` onto status-success would collide with `working`.
    expect(sessionStatusColor('available')).not.toBe(sessionStatusColor('working'))
  })

  it('falls back to text-tertiary for unknown and missing statuses', () => {
    expect(sessionStatusColor(undefined)).toBe(T['text-tertiary'])
    expect(sessionStatusColor('nonsense')).toBe(T['text-tertiary'])
  })

  it('treats dnd as a muted flag rather than a status', () => {
    expect(dndColor()).toBe(T['text-tertiary'])
  })
})

describe('event kind colours', () => {
  it('makes approval_request louder than ordinary errors', () => {
    expect(eventKindColor('approval_request')).toBe(T['status-error-vivid'])
  })

  it('maps the routine kinds onto their status tokens', () => {
    expect(eventKindColor('question')).toBe(T['status-warning'])
    expect(eventKindColor('message')).toBe(T['status-info'])
    expect(eventKindColor('answer')).toBe(T['status-success'])
    expect(eventKindColor('route_failed')).toBe(T['status-error'])
    expect(eventKindColor('notice')).toBe(T['text-tertiary'])
  })

  it('falls back to text-tertiary for unrecognised kinds', () => {
    expect(eventKindColor('nonsense')).toBe(T['text-tertiary'])
  })
})

function flatten(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(flatten)
  if (value && typeof value === 'object') return Object.values(value).flatMap(flatten)
  return []
}
