import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadResolvedConfig, type StorePaths } from '../agents/burndown/settings-store.js'
import {
  NOT_YET_LIVE,
  overrideClear,
  overrideSet,
  pauseSet,
  presetApply,
  presetClear,
  presetList,
  seatSet,
  type SettingsEnv,
} from '../cli/verbs/burndown-config.js'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')

/** The live flat file's shape (CC-955 plan §0), seat names made synthetic. */
const FLAT = {
  enabled: true,
  reportTo: 'coord-a',
  seats: ['coord-a', 'coord-b'],
  maxAgents: 20,
  briefGate: { 'coord-b': 'shadow', 'coord-c': 'shadow', 'coord-a': 'shadow' },
  handReserve: { 'coord-b': 2, 'coord-c': 2, 'coord-a': 2 },
}

let dir: string
let paths: StorePaths
let env: SettingsEnv

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-settings-verbs-'))
  paths = {
    flat: path.join(dir, 'burndown.config.json'),
    settings: path.join(dir, 'burndown.settings.json'),
    override: path.join(dir, 'burndown.override.json'),
    log: path.join(dir, 'burndown.settings.log.jsonl'),
    paused: path.join(dir, 'burndown.paused'),
  }
  fs.writeFileSync(paths.flat, JSON.stringify(FLAT))
  env = { paths, now: NOW, tickReadsSettings: true, brokerStale: () => false }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const logRows = (): Array<Record<string, unknown>> =>
  fs.existsSync(paths.log)
    ? fs
        .readFileSync(paths.log, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : []

const resolved = (now = NOW) => loadResolvedConfig({ paths, now })

describe('burndown preset verbs (CC-955)', () => {
  it('applies factory-only: only the report seat dispatches, gated, and one log row records it', async () => {
    const flatBytes = fs.readFileSync(paths.flat)

    const report = await presetApply(env, 'factory-only', 'tp-operator')

    expect(report.ok).toBe(true)
    const settings = JSON.parse(fs.readFileSync(paths.settings, 'utf8'))
    expect(settings.active).toEqual({
      preset: 'factory-only',
      by: 'tp-operator',
      at: '2026-10-10T12:00:00.000Z',
    })
    const rows = logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ at: '2026-10-10T12:00:00.000Z', by: 'tp-operator', verb: 'preset.apply' })
    expect(rows[0]?.before).toEqual({ settings: { seats: {}, presets: {} } })
    expect((rows[0]?.after as { settings: { active: unknown } }).settings.active).toEqual(settings.active)
    expect(resolved().tick.seats).toEqual(['coord-a'])
    expect(resolved().tick.briefGate['coord-a']).toBe('on')
    expect(fs.readFileSync(paths.flat)).toEqual(flatBytes)
  })

  it('lets a settings-file preset of the same name shadow the built-in', async () => {
    const presets = { 'factory-only': { seats: { 'coord-b': { on: false } } } }
    fs.writeFileSync(paths.settings, JSON.stringify({ presets }))

    await presetApply(env, 'factory-only', 'tp-operator')

    expect(resolved().tick.seats).toEqual(['coord-a'])
    expect(resolved().tick.briefGate['coord-a']).toBe('shadow')
    expect(presetList(paths).lines).toEqual(['factory-only (file, shadows built-in) [active]'])
  })

  it('refuses an unknown preset and writes nothing', async () => {
    const report = await presetApply(env, 'no-such', 'tp-operator')

    expect(report).toMatchObject({ ok: false, errors: ['no preset named no-such; see burndown preset list'] })
    expect(fs.existsSync(paths.settings)).toBe(false)
    expect(logRows()).toEqual([])
  })

  it('refuses factory-only when the flat file names no report seat, and writes nothing', async () => {
    fs.writeFileSync(paths.flat, JSON.stringify({ ...FLAT, reportTo: undefined }))

    const report = await presetApply(env, 'factory-only', 'tp-operator')

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('needs reportTo')
    expect(fs.existsSync(paths.settings)).toBe(false)
  })

  it('clears the active preset and keeps a .bak of the replaced settings', async () => {
    await presetApply(env, 'factory-only', 'tp-operator')

    await presetClear({ ...env, now: NOW + 1000 }, 'tp-operator')

    expect(resolved().preset).toBeUndefined()
    expect(resolved().tick.seats).toEqual(['coord-a', 'coord-b'])
    expect(fs.readdirSync(dir).filter(f => f.startsWith('burndown.settings.json.bak-'))).toHaveLength(1)
    expect(logRows().map(r => r.verb)).toEqual(['preset.apply', 'preset.clear'])
  })
})

describe('repairing settings that no longer resolve (CC-955)', () => {
  it('clears an active factory-only preset after reportTo is removed from the flat file', async () => {
    await presetApply(env, 'factory-only', 'tp-operator')
    fs.writeFileSync(paths.flat, JSON.stringify({ ...FLAT, reportTo: undefined }))

    const report = await presetClear(env, 'tp-operator')

    expect(report.ok).toBe(true)
    expect(resolved().preset).toBeUndefined()
    expect(logRows().map(r => r.verb)).toEqual(['preset.apply', 'preset.clear'])
  })

  it('resumes when the settings file is unreadable, saying the change went unlogged', async () => {
    fs.writeFileSync(paths.paused, 'now\n')
    fs.writeFileSync(paths.settings, '{')

    const report = await pauseSet(env, false, 'tp-operator')

    expect(report.ok).toBe(true)
    expect(fs.existsSync(paths.paused)).toBe(false)
    expect(report.lines[1]).toContain('not logged: burndown settings')
  })
})

describe('before the tick reads the settings (CC-955 S2 pending)', () => {
  it('says a settings change is not live yet', async () => {
    const report = await seatSet({ ...env, tickReadsSettings: false }, 'coord-b', false, 'tp-operator')

    expect(report.lines).toEqual(['seat coord-b off in settings', NOT_YET_LIVE])
  })

  it('does not say so for pause, whose marker the tick reads today', async () => {
    const report = await pauseSet({ ...env, tickReadsSettings: false }, true, 'tp-operator')

    expect(report.lines).toEqual([`paused: ${paths.paused} written`])
  })
})

describe('burndown override verbs (CC-955)', () => {
  const patch = JSON.stringify({ seats: { 'coord-b': { on: false } } })

  it('sets an override that holds for the duration given, then lapses', async () => {
    const report = await overrideSet(env, { patch, duration: '2h', by: 'tp-operator', reason: 'quiet night' })

    expect(report.ok).toBe(true)
    const override = JSON.parse(fs.readFileSync(paths.override, 'utf8'))
    expect(override.expiresAt).toBe('2026-10-10T14:00:00.000Z')
    expect(override).toMatchObject({ by: 'tp-operator', reason: 'quiet night' })
    expect(resolved(NOW + 2 * 3_600_000 - 1).tick.seats).toEqual(['coord-a'])
    expect(resolved(NOW + 2 * 3_600_000).lapsed).toBeDefined()
  })

  it('clears the override file and logs the clear', async () => {
    await overrideSet(env, { patch, duration: '30m', by: 'tp-operator' })

    const report = await overrideClear(env, 'tp-other')

    expect(report.ok).toBe(true)
    expect(fs.existsSync(paths.override)).toBe(false)
    const rows = logRows()
    expect(rows.map(r => [r.verb, r.by])).toEqual([
      ['override.set', 'tp-operator'],
      ['override.clear', 'tp-other'],
    ])
    expect(rows[1]?.after).toEqual({ override: null })
  })

  it.each([
    ['a bad duration', { patch, duration: '2 hours' }, '--for 2 hours'],
    ['a patch that is not JSON', { patch: '{', duration: '1h' }, 'not JSON'],
    ['a patch with an unknown key', { patch: '{"maxAgents":3}', duration: '1h' }, 'malformed'],
  ])('refuses %s and writes nothing', async (_label, args, message) => {
    const report = await overrideSet(env, { ...args, by: 'tp-operator' })

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain(message)
    expect(fs.existsSync(paths.override)).toBe(false)
    expect(logRows()).toEqual([])
  })
})

describe('burndown seat and pause verbs (CC-955)', () => {
  it('turns a seat off in the settings and logs it', async () => {
    const report = await seatSet(env, 'coord-b', false, 'tp-operator')

    expect(report.lines).toEqual(['seat coord-b off in settings'])
    expect(resolved().tick.seats).toEqual(['coord-a'])
    expect(logRows()[0]).toMatchObject({ verb: 'seat.off', by: 'tp-operator' })
  })

  it('warns when turning on a seat the flat file never names', async () => {
    const report = await seatSet(env, 'coord-z', true, 'tp-operator')

    expect(report.lines).toEqual([
      'seat coord-z on in settings',
      'seat coord-z is new: burndown.config.json names no such seat; check the spelling',
    ])
  })

  it('says when an active preset shadows the seat setting', async () => {
    await presetApply(env, 'factory-only', 'tp-operator')

    const report = await seatSet(env, 'coord-b', true, 'tp-operator')

    expect(report.lines).toEqual(['seat coord-b on in settings', 'shadowed: preset keeps seat coord-b off'])
  })

  it('pauses: writes the pause marker the tick reads, and logs who paused', async () => {
    const report = await pauseSet(env, true, 'tp-operator')

    expect(report.ok).toBe(true)
    expect(fs.readFileSync(paths.paused, 'utf8')).toBe('2026-10-10T12:00:00.000Z\n')
    expect(logRows()[0]).toMatchObject({
      verb: 'pause',
      by: 'tp-operator',
      before: { paused: false },
      after: { paused: true },
    })
  })

  it('resumes: removes the pause marker and logs it', async () => {
    await pauseSet(env, true, 'tp-operator')

    await pauseSet(env, false, 'tp-other')

    expect(fs.existsSync(paths.paused)).toBe(false)
    expect(logRows()[1]).toMatchObject({ verb: 'resume', by: 'tp-other', after: { paused: false } })
  })

  it('still pauses when the settings file is unreadable, saying the change went unlogged', async () => {
    fs.writeFileSync(paths.settings, '{')

    const report = await pauseSet(env, true, 'tp-operator')

    expect(report.ok).toBe(true)
    expect(fs.existsSync(paths.paused)).toBe(true)
    expect(report.lines[1]).toContain('not logged: burndown settings')
  })
})

describe('the broker lag warning (CC-955 R3)', () => {
  const lag = 'broker predates settings; handReserve applies to the tick only until restart'

  it('warns when a change moves handReserve and the broker is older than the build', async () => {
    const patch = JSON.stringify({ seats: { 'coord-a': { handReserve: 1 } } })

    const report = await overrideSet(
      { ...env, brokerStale: () => true },
      { patch, duration: '1h', by: 'tp-operator' },
    )

    expect(report.lines).toContain(lag)
  })

  it('stays quiet when handReserve does not move', async () => {
    const report = await seatSet({ ...env, brokerStale: () => true }, 'coord-b', false, 'tp-operator')

    expect(report.lines).not.toContain(lag)
  })
})
