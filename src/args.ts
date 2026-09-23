import { z } from 'zod'
import { TAG_MAX_PER_SESSION, tagProblem } from './protocol.js'

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

/**
 * Globs one session may claim at once. A cap rather than a limit anyone should reach: a claim naming
 * dozens of patterns is describing a whole worktree the long way round, and should claim it instead.
 */
export const CLAIM_MAX_PATTERNS = 24

/**
 * Trimmed globs, or undefined for "the whole worktree" (CC-56). `[]` and an all-blank list collapse to
 * undefined rather than erroring: "claim nothing" and "claim everything" would both be guesses.
 * The cap is enforced here, not in the schema, so the published schema stays as it was.
 */
export function patternList(field: string, list: string[] | undefined): string[] | undefined {
  const kept = (list ?? []).map(pattern => pattern.trim()).filter(pattern => pattern !== '')
  if (kept.length === 0) return undefined
  if (kept.length > CLAIM_MAX_PATTERNS)
    throw new Error(`${field} may name at most ${CLAIM_MAX_PATTERNS} globs; got ${kept.length}`)
  return kept
}

/**
 * A tag list, or undefined when empty. REJECTS rather than trims: a model told its tag was too long
 * learns the shape, while one whose tag was quietly truncated addresses a tag it does not hold.
 */
export function tagList(field: string, list: string[] | undefined): string[] | undefined {
  if (list === undefined || list.length === 0) return undefined
  if (list.length > TAG_MAX_PER_SESSION)
    throw new Error(`${field} may name at most ${TAG_MAX_PER_SESSION} tags; got ${list.length}`)
  for (const tag of list) {
    const problem = tagProblem(tag)
    if (problem) throw new Error(`${field}: ${problem}`)
  }
  return list
}
