import type { BriefGateMode } from './eligibility.js'
import { BUILTIN_PRESETS, type Override, type Preset, type SeatSettings, type Settings } from './settings.js'
import type { TickConfig } from './source.js'

/** Where a resolved value came from; `seat-file` means the settings leave it to the seat file. */
export type Source = 'default' | 'flat' | 'seat-file' | 'settings' | 'preset' | 'override'

export interface ResolvedSeat {
  on: boolean
  briefGate: { mode: BriefGateMode; maxAgeDays: number }
  handReserve: number
  caps: { implementers?: number; planners?: number }
  scope: { tags?: string[]; ids?: string[]; initiatives?: string[] }
}

export interface Layers {
  flat: TickConfig
  /** The flat file's parsed JSON, so a key it names is told apart from a schema default. */
  flatRaw: Record<string, unknown>
  settings?: Settings
  override?: Override
}

export interface Resolved {
  tick: TickConfig
  seats: Record<string, ResolvedSeat>
  paused: boolean
  preset?: string
  sources: Record<string, Source>
  lapsed?: Override
}

interface Tagged<T> {
  value: T
  source: Source
}

type SeatLayer = [Source, SeatSettings | undefined]

/** The active preset, built-ins shadowed by the file's own; an unknown name throws rather than resolving without it. */
function activePreset(flat: TickConfig, settings: Settings | undefined): Preset | undefined {
  const wanted = settings?.active?.preset
  if (wanted === undefined) return undefined
  const preset =
    settings?.presets[wanted] ??
    BUILTIN_PRESETS[wanted]?.({
      ...(flat.reportTo === undefined ? {} : { reportTo: flat.reportTo }),
      seats: seatNames(flat, [settings?.seats]),
    })
  if (preset === undefined) throw new Error(`burndown settings names unknown preset ${wanted}`)
  return preset
}

function layered<T>(
  base: Tagged<T>,
  layers: SeatLayer[],
  get: (s: SeatSettings) => T | undefined,
): Tagged<T> {
  let out = base
  for (const [source, seat] of layers) {
    const value = seat === undefined ? undefined : get(seat)
    if (value !== undefined) out = { value, source }
  }
  return out
}

const flatOr = <T>(present: boolean, value: T): Tagged<T> => ({ value, source: present ? 'flat' : 'default' })
const seatFile: Tagged<undefined> = { value: undefined, source: 'seat-file' }

function seatTags(seat: string, layers: SeatLayer[], { flat, flatRaw }: Layers) {
  const pick = <T>(base: Tagged<T>, get: (s: SeatSettings) => T | undefined) => layered(base, layers, get)
  const maybe = <T>(get: (s: SeatSettings) => T | undefined) => pick<T | undefined>(seatFile, get)
  return {
    on: pick(flatOr('seats' in flatRaw, flat.seats.includes(seat)), s => s.on),
    'briefGate.mode': pick(
      flatOr(seat in flat.briefGate, flat.briefGate[seat] ?? 'off'),
      s => s.briefGate?.mode,
    ),
    'briefGate.maxAgeDays': pick(
      flatOr('briefMaxAgeDays' in flatRaw, flat.briefMaxAgeDays),
      s => s.briefGate?.maxAgeDays,
    ),
    handReserve: pick(flatOr(seat in flat.handReserve, flat.handReserve[seat] ?? 0), s => s.handReserve),
    'caps.implementers': maybe(s => s.caps?.implementers),
    'caps.planners': maybe(s => s.caps?.planners),
    'scope.tags': maybe(s => s.scope?.tags),
    'scope.ids': maybe(s => s.scope?.ids),
    'scope.initiatives': maybe(s => s.scope?.initiatives),
  }
}

function resolveSeat(
  seat: string,
  layers: SeatLayer[],
  base: Layers,
): [ResolvedSeat, Record<string, Source>] {
  const t = seatTags(seat, layers, base)
  const sources = Object.fromEntries(
    Object.entries(t).map(([key, tag]) => [`seats.${seat}.${key}`, tag.source]),
  )
  const resolved: ResolvedSeat = {
    on: t.on.value,
    briefGate: { mode: t['briefGate.mode'].value, maxAgeDays: t['briefGate.maxAgeDays'].value },
    handReserve: t.handReserve.value,
    caps: definedOnly({ implementers: t['caps.implementers'].value, planners: t['caps.planners'].value }),
    scope: definedOnly({
      tags: t['scope.tags'].value,
      ids: t['scope.ids'].value,
      initiatives: t['scope.initiatives'].value,
    }),
  }
  return [resolved, sources]
}

const definedOnly = <T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }

function seatNames(flat: TickConfig, patches: Array<Record<string, SeatSettings> | undefined>): string[] {
  const all = [
    flat.seats,
    Object.keys(flat.briefGate),
    Object.keys(flat.handReserve),
    ...patches.map(p => Object.keys(p ?? {})),
  ]
  return [...new Set(all.flat())]
}

const fromLayers = (source: Source) => source !== 'flat' && source !== 'default' && source !== 'seat-file'

/** Projects per-seat values back into the flat shape, so a consumer of `TickConfig` reads them unchanged. */
function project(
  flat: TickConfig,
  seats: Record<string, ResolvedSeat>,
  sources: Record<string, Source>,
): TickConfig {
  const layeredKey = (seat: string, key: string) => fromLayers(sources[`seats.${seat}.${key}`] ?? 'default')
  const on = (seat: string) => seats[seat]?.on ?? true
  const added = Object.keys(seats).filter(seat => seats[seat]?.on && !flat.seats.includes(seat))
  const briefGate = { ...flat.briefGate }
  const handReserve = { ...flat.handReserve }
  for (const [seat, resolved] of Object.entries(seats)) {
    if (layeredKey(seat, 'briefGate.mode')) briefGate[seat] = resolved.briefGate.mode
    if (layeredKey(seat, 'handReserve')) handReserve[seat] = resolved.handReserve
  }
  return { ...flat, seats: [...flat.seats.filter(on), ...added], briefGate, handReserve }
}

function liveOverride(override: Override | undefined, now: number): { live?: Override; lapsed?: Override } {
  if (override === undefined) return {}
  return now >= Date.parse(override.expiresAt) ? { lapsed: override } : { live: override }
}

/** `paused` lives only in presets and overrides; the `burndown.paused` file stays the tick's own switch. */
function pausedTag(preset: Preset | undefined, live: Override | undefined): Tagged<boolean> {
  if (live?.patch.paused !== undefined) return { value: live.patch.paused, source: 'override' }
  if (preset?.paused !== undefined) return { value: preset.paused, source: 'preset' }
  return { value: false, source: 'default' }
}

function topSources(flat: TickConfig, flatRaw: Record<string, unknown>): Record<string, Source> {
  const perSeat = new Set(['seats', 'briefGate', 'handReserve'])
  const keys = Object.keys(flat).filter(key => !perSeat.has(key))
  return Object.fromEntries(keys.map(key => [key, key in flatRaw ? 'flat' : 'default']))
}

/** Lowest first; `patches` in `resolve` follows the same order. */
const SEAT_LAYERS: Source[] = ['settings', 'preset', 'override']

/** CC-955: default < flat file < settings `seats` < active preset < unexpired override, each value tagged with its layer. */
export function resolve(layers: Layers, now: number): Resolved {
  const { flat, settings } = layers
  const preset = activePreset(flat, settings)
  const { live, lapsed } = liveOverride(layers.override, now)
  const patches = [settings?.seats, preset?.seats, live?.patch.seats]
  const sources = topSources(flat, layers.flatRaw)
  const seats: Record<string, ResolvedSeat> = {}
  for (const seat of seatNames(flat, patches)) {
    const seatLayers = SEAT_LAYERS.map((source, i): SeatLayer => [source, patches[i]?.[seat]])
    const [resolved, seatSources] = resolveSeat(seat, seatLayers, layers)
    seats[seat] = resolved
    Object.assign(sources, seatSources)
  }
  const paused = pausedTag(preset, live)
  sources.paused = paused.source
  const out: Resolved = { tick: project(flat, seats, sources), seats, paused: paused.value, sources }
  if (settings?.active !== undefined) out.preset = settings.active.preset
  if (lapsed !== undefined) out.lapsed = lapsed
  return out
}
