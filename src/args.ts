import { z } from 'zod'

/** Rejects blank as well as absent: `String(undefined)` once reached a peer as the word "undefined". */
export const nonBlank = (message: string) =>
  z.string({ error: message }).refine(value => value.trim() !== '', message)

export const requiredString = (field: string) =>
  nonBlank(`${field} is required and must be a non-empty string`)
