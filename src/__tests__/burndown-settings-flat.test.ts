import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadResolvedConfig, type SettingsPaths } from '../agents/burndown/settings-store.js'
import { loadTickConfig } from '../agents/burndown/source.js'

/** The live flat file's shape (CC-955 plan §0), seat names made synthetic. */
const LIVE_SHAPE = {
  enabled: true,
  reportTo: 'coord-a',
  seats: ['coord-a'],
  maxAgents: 20,
  maxWorktreesPerRepo: 12,
  briefGate: { 'coord-b': 'shadow', 'coord-c': 'shadow', 'coord-a': 'on' },
  handReserve: { 'coord-b': 2, 'coord-c': 2, 'coord-a': 2 },
}

let dir: string
let paths: SettingsPaths

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-settings-flat-'))
  paths = {
    flat: path.join(dir, 'burndown.config.json'),
    settings: path.join(dir, 'burndown.settings.json'),
    override: path.join(dir, 'burndown.override.json'),
  }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const writeFlat = (content: unknown) => fs.writeFileSync(paths.flat, JSON.stringify(content))

describe('burndown settings over a flat file alone (CC-955)', () => {
  it.each([
    ['the live shape', LIVE_SHAPE],
    [
      'a gate on a seat with no hand reserve',
      { seats: ['coord-a', 'coord-b'], briefGate: { 'coord-c': 'on' } },
    ],
    ['an empty file', {}],
  ])('resolves %s to exactly what loadTickConfig reads', (_label, content) => {
    writeFlat(content)

    const resolved = loadResolvedConfig({ paths, now: 0 })

    expect(resolved.tick).toEqual(loadTickConfig(paths.flat))
    const layered = Object.values(resolved.sources).filter(s => !['flat', 'default', 'seat-file'].includes(s))
    expect(layered).toEqual([])
  })

  it('resolves no flat file to the schema defaults, every source default', () => {
    const resolved = loadResolvedConfig({ paths, now: 0 })

    expect(resolved.tick).toEqual(loadTickConfig(paths.flat))
    expect(new Set(Object.values(resolved.sources))).toEqual(new Set(['default']))
  })

  it('labels a key the flat file names as flat, and one it omits as default', () => {
    writeFlat(LIVE_SHAPE)

    const { sources } = loadResolvedConfig({ paths, now: 0 })

    expect(sources.maxAgents).toBe('flat')
    expect(sources.reserveSlots).toBe('default')
    expect(sources['seats.coord-b.briefGate.mode']).toBe('flat')
    expect(sources['seats.coord-b.on']).toBe('flat')
  })

  it('still parses a flat file carrying an unknown key, dropping it (R2)', () => {
    writeFlat({ seats: [], bogus: 1 })

    const resolved = loadResolvedConfig({ paths, now: 0 })

    expect(resolved.tick.seats).toEqual([])
    expect(resolved.tick).not.toHaveProperty('bogus')
  })
})
