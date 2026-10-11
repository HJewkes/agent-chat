import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Override, SeatSettings, Settings } from '../agents/burndown/settings.js'
import { resolve, type Layers } from '../agents/burndown/settings-resolve.js'
import { loadResolvedConfig } from '../agents/burndown/settings-store.js'
import { TickConfigSchema } from '../agents/burndown/source.js'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const SEAT = 'seat-a'

const flatLayer = (raw: Record<string, unknown>): Pick<Layers, 'flat' | 'flatRaw'> => ({
  flat: TickConfigSchema.parse(raw),
  flatRaw: raw,
})

const settingsWith = (seat: SeatSettings | undefined, preset: SeatSettings | undefined): Settings => ({
  seats: seat === undefined ? {} : { [SEAT]: seat },
  presets: preset === undefined ? {} : { quiet: { seats: { [SEAT]: preset } } },
  ...(preset === undefined
    ? {}
    : { active: { preset: 'quiet', by: 'tester', at: '2026-10-10T00:00:00.000Z' } }),
})

const overrideOf = (patch: Override['patch'], expiresAt = '2026-10-10T14:00:00.000Z'): Override => ({
  patch,
  by: 'tester',
  at: '2026-10-10T10:00:00.000Z',
  expiresAt,
})

const gate = (mode: 'off' | 'shadow' | 'on'): SeatSettings => ({ briefGate: { mode } })

describe('burndown settings resolution order (CC-955)', () => {
  const flat = { seats: [SEAT], briefGate: { [SEAT]: 'shadow' } }
  it.each([
    ['every layer', flat, gate('on'), gate('off'), gate('shadow'), 'shadow', 'override'],
    ['no override', flat, gate('on'), gate('off'), undefined, 'off', 'preset'],
    ['no preset', flat, gate('on'), undefined, undefined, 'on', 'settings'],
    ['no settings', flat, undefined, undefined, undefined, 'shadow', 'flat'],
    ['no flat gate', { seats: [SEAT] }, undefined, undefined, undefined, 'off', 'default'],
  ] as const)('with %s, takes the top layer', (_label, raw, seat, preset, patch, mode, source) => {
    const layers: Layers = {
      ...flatLayer(raw),
      settings: settingsWith(seat, preset),
      ...(patch === undefined ? {} : { override: overrideOf({ seats: { [SEAT]: patch } }) }),
    }

    const resolved = resolve(layers, NOW)

    expect(resolved.seats[SEAT]?.briefGate.mode).toBe(mode)
    expect(resolved.sources[`seats.${SEAT}.briefGate.mode`]).toBe(source)
  })

  it('projects per-seat on and handReserve back into the flat tick shape', () => {
    const layers: Layers = {
      ...flatLayer({ seats: [SEAT], handReserve: { [SEAT]: 2 } }),
      settings: {
        seats: { [SEAT]: { on: false }, 'seat-b': { on: true, handReserve: 1, ...gate('on') } },
        presets: {},
      },
    }

    const { tick } = resolve(layers, NOW)

    expect(tick.seats).toEqual(['seat-b'])
    expect(tick.handReserve).toEqual({ [SEAT]: 2, 'seat-b': 1 })
    expect(tick.briefGate).toEqual({ 'seat-b': 'on' })
  })

  it('refuses an active preset that names nothing', () => {
    const layers: Layers = {
      ...flatLayer({}),
      settings: {
        seats: {},
        presets: {},
        active: { preset: 'gone', by: 'tester', at: '2026-10-10T00:00:00.000Z' },
      },
    }

    expect(() => resolve(layers, NOW)).toThrow(/unknown preset gone/)
  })
})

describe('burndown override expiry (CC-955)', () => {
  const expiresAt = '2026-10-10T12:00:00.000Z'
  const layers = (): Layers => ({
    ...flatLayer({ seats: [SEAT] }),
    override: overrideOf({ seats: { [SEAT]: { on: false } } }, expiresAt),
  })

  it('ignores an override at its expiresAt and names it lapsed', () => {
    const resolved = resolve(layers(), Date.parse(expiresAt))

    expect(resolved.tick.seats).toEqual([SEAT])
    expect(resolved.lapsed?.expiresAt).toBe(expiresAt)
  })

  it('applies the override one millisecond before it expires', () => {
    const resolved = resolve(layers(), Date.parse(expiresAt) - 1)

    expect(resolved.tick.seats).toEqual([])
    expect(resolved.sources[`seats.${SEAT}.on`]).toBe('override')
    expect(resolved.lapsed).toBeUndefined()
  })
})

describe('malformed burndown settings (CC-955)', () => {
  it.each([
    ['a schema violation', JSON.stringify({ seats: { [SEAT]: { on: 'yes' } } })],
    ['broken JSON', '{"seats":'],
  ])('throws on %s rather than falling back to defaults', (_label, text) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-settings-bad-'))
    const paths = {
      flat: path.join(dir, 'burndown.config.json'),
      settings: path.join(dir, 'burndown.settings.json'),
      override: path.join(dir, 'burndown.override.json'),
    }
    fs.writeFileSync(paths.settings, text)
    try {
      expect(() => loadResolvedConfig({ paths, now: NOW })).toThrow(/^burndown settings .* is malformed/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
