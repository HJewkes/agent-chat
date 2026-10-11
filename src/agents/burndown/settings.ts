import { z } from 'zod'
import { BRIEF_GATES } from './eligibility.js'

/** CC-955: the structured burndown settings layered over the flat `burndown.config.json`. */

const name = z.string().min(1)
const count = z.number().int().nonnegative()
const names = z.array(name)

export const SeatSettings = z
  .object({
    on: z.boolean().optional(),
    scope: z
      .object({ tags: names.optional(), ids: names.optional(), initiatives: names.optional() })
      .strict()
      .optional(),
    briefGate: z
      .object({ mode: z.enum(BRIEF_GATES).optional(), maxAgeDays: z.number().int().positive().optional() })
      .strict()
      .optional(),
    caps: z.object({ implementers: count.optional(), planners: count.optional() }).strict().optional(),
    handReserve: count.optional(),
  })
  .strict()
export type SeatSettings = z.infer<typeof SeatSettings>

/** A partial of the settings: what a preset or an override patch may set. */
export const Preset = z
  .object({ seats: z.record(name, SeatSettings).optional(), paused: z.boolean().optional() })
  .strict()
export type Preset = z.infer<typeof Preset>

export const Settings = z
  .object({
    seats: z.record(name, SeatSettings).default({}),
    presets: z.record(name, Preset).default({}),
    active: z.object({ preset: name, by: name, at: z.iso.datetime() }).strict().optional(),
  })
  .strict()
export type Settings = z.infer<typeof Settings>

export const Override = z
  .object({
    patch: Preset,
    by: name,
    at: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    reason: z.string().optional(),
  })
  .strict()
export type Override = z.infer<typeof Override>

/** Presets defined in code; a preset of the same name in the settings file shadows one here. */
export const BUILTIN_PRESETS: Readonly<Record<string, Preset>> = {}
