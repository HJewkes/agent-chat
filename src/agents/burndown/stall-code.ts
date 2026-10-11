/**
 * The closed set of codes a stall or a stalled-after-claim finding carries
 * (CC-663), in precedence order: when two hold, the earlier wins. A stall
 * outside these kinds keeps its `stalledClass` and carries no code.
 */

import type { Action, ClaimKey } from './advance.js'
import type { ExceptionClass } from './exception.js'

export const STALL_CODES = [
  'spawn-never-landed',
  'shepherd-ended',
  'planner-refused',
  'retry-spent',
  'budget',
  'phase-timeout',
  'dirty-uncommitted',
  'lease-expired',
  'no-progress',
] as const
export type StallCode = (typeof STALL_CODES)[number]

/** Codes a respawn or release can fix; `shepherd-ended`, `planner-refused`, `retry-spent` and `budget` go straight to the owner (a respawn under `budget` would spend more). */
export const LADDER_CODES: readonly StallCode[] = [
  'spawn-never-landed',
  'phase-timeout',
  'dirty-uncommitted',
  'lease-expired',
  'no-progress',
]

/** The code of highest precedence among `codes`, absent when there is none. */
export const firstCode = (codes: readonly StallCode[]): StallCode | undefined =>
  STALL_CODES.find(code => codes.includes(code))

const PARK_CLASS: Record<StallCode, ExceptionClass> = {
  'spawn-never-landed': 'stalled',
  'shepherd-ended': 'failed',
  'planner-refused': 'failed',
  'retry-spent': 'failed',
  budget: 'failed',
  'phase-timeout': 'stalled',
  'dirty-uncommitted': 'stalled',
  'lease-expired': 'stalled',
  'no-progress': 'stalled',
}

/** The one shape of a park: the claim's stall patch with its class taken from the code. */
export const parkUpdate = (
  key: ClaimKey,
  code: StallCode,
  detail: string,
): Extract<Action, { kind: 'update' }> => ({
  kind: 'update',
  key,
  patch: { stalledReason: `${code}: ${detail}`, stalledClass: PARK_CLASS[code], stallCode: code },
})
