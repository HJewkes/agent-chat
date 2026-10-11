import fs from 'node:fs'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import { BUILTIN_PRESETS, Preset } from '../../agents/burndown/settings.js'
import type { Resolved, ResolvedSeat } from '../../agents/burndown/settings-resolve.js'
import {
  changeSettings,
  defaultStorePaths,
  loadResolvedConfig,
  readSnapshot,
  type Snapshot,
  type StorePaths,
} from '../../agents/burndown/settings-store.js'
import { readMeta } from '../../broker/lifecycle.js'
import { newestBuildMtime, stalenessWarning } from '../../broker/staleness.js'
import { defineVerb, Report } from '../command.js'

const show = (value: unknown): string => (value === undefined ? '(seat file)' : JSON.stringify(value))

function seatLines(seat: string, resolved: ResolvedSeat, sources: Resolved['sources']): string[] {
  const values: Record<string, unknown> = {
    on: resolved.on,
    'briefGate.mode': resolved.briefGate.mode,
    'briefGate.maxAgeDays': resolved.briefGate.maxAgeDays,
    handReserve: resolved.handReserve,
    'caps.implementers': resolved.caps.implementers,
    'caps.planners': resolved.caps.planners,
    'scope.tags': resolved.scope.tags,
    'scope.ids': resolved.scope.ids,
    'scope.initiatives': resolved.scope.initiatives,
  }
  return Object.entries(values).map(
    ([key, value]) => `  ${key} = ${show(value)}  [${sources[`seats.${seat}.${key}`] ?? 'default'}]`,
  )
}

/** Every resolved value with the layer it came from; a lapsed override is named, never applied. */
export function renderResolved(resolved: Resolved): string[] {
  const { tick, sources } = resolved
  const top = Object.entries(tick)
    .filter(([key]) => key in sources)
    .map(([key, value]) => `${key} = ${show(value)}  [${sources[key]}]`)
  const header = [
    `preset: ${resolved.preset ?? '(none)'}`,
    `paused = ${resolved.paused}  [${sources.paused}]`,
    ...(resolved.lapsed === undefined
      ? []
      : [`override lapsed at ${resolved.lapsed.expiresAt} (set by ${resolved.lapsed.by}); not applied`]),
  ]
  const seats = Object.entries(resolved.seats).flatMap(([seat, r]) => [
    `seat ${seat}:`,
    ...seatLines(seat, r, sources),
  ])
  return [...header, ...top, ...seats]
}

export const burndownConfigShowVerb = defineVerb({
  name: 'burndown.config.show',
  description: 'print the resolved burndown config, each value with the layer it came from (CC-955)',
  args: z.object({ json: z.boolean().optional() }),
  result: Report,
  cli: { options: { json: { long: '--json', description: 'print the resolved config as one JSON object' } } },
  async run({ json }) {
    try {
      const resolved = loadResolvedConfig()
      return { ok: true, lines: json ? [JSON.stringify(resolved)] : renderResolved(resolved) }
    } catch (err) {
      return { ok: false, lines: [], errors: [(err as Error).message] }
    }
  },
})

/** Where a settings verb writes, its clock, and whether the running broker predates the build. */
export interface SettingsEnv {
  paths: StorePaths
  now: number
  brokerStale: () => boolean
}

/** No broker is not stale; one with no build stamp may predate the settings, so it counts. */
function liveBrokerStale(): boolean {
  const meta = readMeta()
  if (meta === null) return false
  return meta.buildMtime === undefined || stalenessWarning(meta.buildMtime, newestBuildMtime()) !== null
}

const liveEnv = (): SettingsEnv => ({
  paths: defaultStorePaths(),
  now: Date.now(),
  brokerStale: liveBrokerStale,
})

const failed = (err: unknown): Report => ({ ok: false, lines: [], errors: [(err as Error).message] })

/** The broker reads `handReserve` in-process, so a change to it waits for a broker restart (plan R3). */
const BROKER_LAG = 'broker predates settings; handReserve applies to the tick only until restart'

async function settingsChange(
  env: SettingsEnv,
  verb: string,
  by: string,
  edit: (current: Snapshot) => Snapshot,
  done: (after: Resolved) => string[],
): Promise<Report> {
  try {
    const { before, after } = await changeSettings(env.paths, { verb, by, now: env.now }, edit)
    const reserveMoved = JSON.stringify(before.tick.handReserve) !== JSON.stringify(after.tick.handReserve)
    const lag = reserveMoved && env.brokerStale() ? [BROKER_LAG] : []
    return { ok: true, lines: [...done(after), ...lag] }
  } catch (err) {
    return failed(err)
  }
}

function knownPreset(paths: StorePaths, name: string): void {
  if (readSnapshot(paths).settings.presets[name] === undefined && BUILTIN_PRESETS[name] === undefined)
    throw new Error(`no preset named ${name}; see burndown preset list`)
}

export async function presetApply(env: SettingsEnv, name: string, by: string): Promise<Report> {
  try {
    knownPreset(env.paths, name)
  } catch (err) {
    return failed(err)
  }
  const at = new Date(env.now).toISOString()
  return settingsChange(
    env,
    'preset.apply',
    by,
    s => ({ ...s, settings: { ...s.settings, active: { preset: name, by, at } } }),
    after => [`preset ${name} active`, ...renderResolved(after)],
  )
}

export async function presetClear(env: SettingsEnv, by: string): Promise<Report> {
  return settingsChange(
    env,
    'preset.clear',
    by,
    s => {
      const { active: _dropped, ...settings } = s.settings
      return { ...s, settings }
    },
    () => ['no preset active'],
  )
}

export function presetList(paths: StorePaths): Report {
  const { settings } = readSnapshot(paths)
  const mine = Object.keys(settings.presets)
  const builtin = Object.keys(BUILTIN_PRESETS)
  const label = (name: string) =>
    `${name}${builtin.includes(name) ? (mine.includes(name) ? ' (file, shadows built-in)' : ' (built-in)') : ' (file)'}${settings.active?.preset === name ? ' [active]' : ''}`
  return { ok: true, lines: [...new Set([...builtin, ...mine])].map(label) }
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `30m`, `2h` or `1d`. */
export function parseDuration(text: string): number {
  const match = /^([1-9][0-9]*)([mhd])$/.exec(text)
  if (match === null) throw new Error(`--for ${text}: give a duration like 30m, 2h or 1d`)
  return Number(match[1]) * (UNIT_MS[match[2] as string] as number)
}

function parsePatch(text: string): Preset {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new Error(`override patch is not JSON: ${(err as Error).message}`)
  }
  const parsed = Preset.safeParse(json)
  if (!parsed.success) throw new Error(`override patch is malformed: ${parsed.error.message}`)
  return parsed.data
}

export async function overrideSet(
  env: SettingsEnv,
  args: { patch: string; duration: string; by: string; reason?: string },
): Promise<Report> {
  let override: NonNullable<Snapshot['override']>
  try {
    override = {
      patch: parsePatch(args.patch),
      by: args.by,
      at: new Date(env.now).toISOString(),
      expiresAt: new Date(env.now + parseDuration(args.duration)).toISOString(),
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    }
  } catch (err) {
    return failed(err)
  }
  return settingsChange(
    env,
    'override.set',
    args.by,
    s => ({ ...s, override }),
    () => [`override set until ${override.expiresAt}`],
  )
}

export async function overrideClear(env: SettingsEnv, by: string): Promise<Report> {
  return settingsChange(
    env,
    'override.clear',
    by,
    ({ override: _dropped, ...s }) => s,
    () => ['override cleared'],
  )
}

/** A higher layer can shadow the seat's own setting, so the reply says what the tick will really see. */
export async function seatSet(env: SettingsEnv, seat: string, on: boolean, by: string): Promise<Report> {
  return settingsChange(
    env,
    on ? 'seat.on' : 'seat.off',
    by,
    s => {
      const seats = { ...s.settings.seats, [seat]: { ...s.settings.seats[seat], on } }
      return { ...s, settings: { ...s.settings, seats } }
    },
    after => {
      const source = after.sources[`seats.${seat}.on`]
      const shadowed =
        after.seats[seat]?.on !== on ? [`shadowed: ${source} keeps seat ${seat} ${on ? 'off' : 'on'}`] : []
      return [`seat ${seat} ${on ? 'on' : 'off'} in settings`, ...shadowed]
    },
  )
}

/**
 * The pause marker stays the tick's switch; the change is logged like any other. Pause is the
 * kill switch, so a settings lock or an unresolvable settings file never stops the marker landing.
 */
export async function pauseSet(env: SettingsEnv, paused: boolean, by: string): Promise<Report> {
  const done = paused ? `paused: ${env.paths.paused} written` : 'resumed'
  const report = await settingsChange(
    env,
    paused ? 'pause' : 'resume',
    by,
    s => ({ ...s, paused }),
    () => [done],
  )
  if (report.ok || !paused) return report
  fs.writeFileSync(env.paths.paused, `${new Date(env.now).toISOString()}\n`)
  return { ok: true, lines: [done, `not logged: ${(report.errors ?? []).join('; ')}`] }
}

const byArg = requiredString('by')
const byOption = { long: '--by <who>', description: 'who is making the change; recorded in the settings log' }

export const burndownPresetApplyVerb = defineVerb({
  name: 'burndown.preset.apply',
  description: 'make a preset the active one over the burndown settings (CC-955)',
  args: z.object({ name: requiredString('name'), by: byArg }),
  result: Report,
  cli: { positional: ['name'], options: { by: byOption } },
  run: ({ name, by }) => presetApply(liveEnv(), name, by),
})

export const burndownPresetClearVerb = defineVerb({
  name: 'burndown.preset.clear',
  description: 'leave no preset active (CC-955)',
  args: z.object({ by: byArg }),
  result: Report,
  cli: { options: { by: byOption } },
  run: ({ by }) => presetClear(liveEnv(), by),
})

export const burndownPresetListVerb = defineVerb({
  name: 'burndown.preset.list',
  description: 'list the built-in and settings-file presets, marking the active one (CC-955)',
  args: z.object({}),
  result: Report,
  async run() {
    try {
      return presetList(defaultStorePaths())
    } catch (err) {
      return failed(err)
    }
  },
})

export const burndownOverrideSetVerb = defineVerb({
  name: 'burndown.override.set',
  description: 'lay a time-boxed JSON patch over the burndown settings (CC-955)',
  args: z.object({
    patch: requiredString('patch'),
    for: requiredString('for'),
    by: byArg,
    reason: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['patch'],
    options: {
      for: { long: '--for <duration>', description: 'how long the patch holds: 30m, 2h or 1d' },
      by: byOption,
      reason: { long: '--reason <text>', description: 'why, kept with the override' },
    },
  },
  run: ({ patch, for: duration, by, reason }) =>
    overrideSet(liveEnv(), { patch, duration, by, ...(reason === undefined ? {} : { reason }) }),
})

export const burndownOverrideClearVerb = defineVerb({
  name: 'burndown.override.clear',
  description: 'remove the override before it expires (CC-955)',
  args: z.object({ by: byArg }),
  result: Report,
  cli: { options: { by: byOption } },
  run: ({ by }) => overrideClear(liveEnv(), by),
})

const seatVerb = (on: boolean) =>
  defineVerb({
    name: on ? 'burndown.seat.on' : 'burndown.seat.off',
    description: `turn a seat ${on ? 'on' : 'off'} in the burndown settings (CC-955)`,
    args: z.object({ seat: requiredString('seat'), by: byArg }),
    result: Report,
    cli: { positional: ['seat'], options: { by: byOption } },
    run: ({ seat, by }) => seatSet(liveEnv(), seat, on, by),
  })

export const burndownSeatOnVerb = seatVerb(true)
export const burndownSeatOffVerb = seatVerb(false)

/** `--by` stays optional on pause and resume so existing callers keep working; the log then names no one. */
export const UNRECORDED = '(unrecorded)'

export const pauseByArgs = z.object({ by: z.string().min(1).optional() })
export const pauseByCli = { options: { by: byOption } }

export const pauseFromCli = (paused: boolean, who: string | undefined) =>
  pauseSet(liveEnv(), paused, who ?? UNRECORDED)
