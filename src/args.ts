import { z } from 'zod'

/** Rejects blank as well as absent: `String(undefined)` once reached a peer as the word "undefined". */
export const nonBlank = (message: string) =>
  z.string({ error: message }).refine(value => value.trim() !== '', message)

export const requiredString = (field: string) =>
  nonBlank(`${field} is required and must be a non-empty string`)

/** Blank counts as absent, as `optionalString` always treated it: the field is opt-in, not opt-blank. */
export const present = (value: string | undefined): string | undefined => (value?.trim() ? value : undefined)

/**
 * A limit field, still accepting `"5"` the way `Number(value)` did. Bounds enforcement (the
 * fallback and the cap) happens in `run` via `clampLimit`, not here: a schema default would make
 * the field `required` under registry's output-mode JSON Schema (G1).
 */
export const positiveLimit = (field: string) =>
  z.coerce
    .number({ error: `${field} must be a positive number` })
    .refine(value => Number.isFinite(value) && value >= 1, `${field} must be a positive number`)

/** `Number(undefined)` was NaN, which is why an absent limit fell back rather than erroring. */
export const clampLimit = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined ? fallback : Math.min(Math.floor(value), max)
