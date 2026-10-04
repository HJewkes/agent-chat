/**
 * The closed set of codes a stall or a stalled-after-claim finding carries
 * (CC-663), in precedence order: when two hold, the earlier wins. A stall
 * outside these kinds keeps its `stalledClass` and carries no code.
 */

export const STALL_CODES = [
  'spawn-never-landed',
  'shepherd-ended',
  'planner-refused',
  'phase-timeout',
  'dirty-uncommitted',
  'lease-expired',
  'no-progress',
] as const
export type StallCode = (typeof STALL_CODES)[number]

/** Codes a respawn or release can fix; `shepherd-ended` and `planner-refused` go straight to the owner. */
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
