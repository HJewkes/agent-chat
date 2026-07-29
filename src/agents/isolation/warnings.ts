/**
 * §7.1 gives `check` a single array, but a caller has to tell "you are sharing a
 * checkout with bob" (spawn proceeds, the line goes in `spawn_result.warnings`)
 * from "that branch still holds uncommitted work" (spawn does not proceed).
 * Rather than widen the frozen interface, advisory lines carry this prefix and
 * callers split on it. Anything unprefixed is a refusal.
 *
 * Its own module rather than index.ts so that strategies can import the value
 * without a runtime import cycle back through the registry.
 */
export const WARNING_PREFIX = 'warning: '

export const warn = (reason: string): string => `${WARNING_PREFIX}${reason}`

export const isWarning = (reason: string): boolean => reason.startsWith(WARNING_PREFIX)

export const refusalsIn = (reasons: readonly string[]): string[] => reasons.filter(r => !isWarning(r))
