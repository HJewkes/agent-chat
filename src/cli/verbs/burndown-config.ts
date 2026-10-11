import { z } from 'zod'
import type { Resolved, ResolvedSeat } from '../../agents/burndown/settings-resolve.js'
import { loadResolvedConfig } from '../../agents/burndown/settings-store.js'
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
