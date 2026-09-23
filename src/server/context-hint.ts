import { contextTokens, readBudget, type PromptCache } from '../agents/budget.js'
import type { ContextHintPolicy } from '../config.js'

/**
 * Tell a session its context is filling up, on a frame it was already getting.
 *
 * A session cannot see its own context fill; `session_budget` can answer, but it
 * is a PULL and an agent deep in a task has no reason to call it. By the time
 * anyone notices, the useful moment to wrap has passed.
 *
 * WHY THIS RIDES AN EXISTING FRAME rather than being pushed. Fanout cost is
 * payload x recipients, which is the whole reason broadcasts are budgeted, so a
 * periodic push to every session is the one shape this architecture rules out.
 * Appending a line to a message the session is already receiving costs nothing,
 * needs no new channel, and lands while the agent is mid-turn and able to act.
 *
 * WHY IT NAMES THE ACTION rather than just the number. CC-84: an agent acts on
 * instruction text far more reliably than on ambient data — it read a
 * tool-limits sentence in its brief and believed it over its own toolset. A bare
 * "212k" is data. "At your next stopping point, teleport" is a thing to do.
 *
 * The cost of this being WRONG is the reason for the hysteresis below: a hint
 * that repeats becomes noise, and an agent that has learned to skim one line
 * will skim the one that mattered.
 */

/**
 * One crossing point per role, in absolute tokens (CC-128).
 *
 * Percent of window was the wrong unit: on a 1M window 70% is 700k, and most of a
 * long session's cost is already paid above 100k. The window guard keeps the old
 * 85% behaviour for small windows, where the role's number may be unreachable.
 */
export const WINDOW_GUARD_PCT = 85

export function thresholdFor(policy: ContextHintPolicy, windowSize: number | undefined): number {
  if (windowSize === undefined) return policy.tokens
  return Math.min(policy.tokens, Math.round((windowSize * WINDOW_GUARD_PCT) / 100))
}

/**
 * Whether handing off now saves a cache rebuild. Said only when Claude Code
 * reported it; a cache that already went cold during an idle gap is no reason to hurry.
 */
export function cacheSentence(cache: PromptCache | undefined, now: number): string | undefined {
  if (cache === undefined || cache.caching_observed === false || cache.warm === undefined) return undefined
  const msLeft = cache.expires_at === undefined ? undefined : cache.expires_at * 1000 - now
  if (!cache.warm || (msLeft !== undefined && msLeft <= 0)) {
    return 'Your prompt cache has already gone cold, so there is no rush: reach the boundary first.'
  }
  const left = msLeft === undefined ? '' : ` for about ${Math.max(1, Math.round(msLeft / 60_000))} more min`
  return `Your prompt cache is warm${left}: hand off while it is still warm.`
}

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

/**
 * Tracks whether a session has already been told, so the crossing is announced
 * once.
 *
 * Falling back below the threshold re-arms it. That is not a real case for a
 * context window, which only grows, but it IS real after a teleport or a
 * `/compact`: the figure drops and a later crossing deserves a new line.
 */
export class ContextHinter {
  private announced = false

  /** `policy` null means this role is never hinted. */
  constructor(
    private readonly sessionId: string | undefined,
    private readonly policy: ContextHintPolicy | null,
    private readonly read: typeof readBudget = readBudget,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The line to append to an outbound frame, or undefined for "say nothing".
   *
   * Silent unless the threshold was newly crossed. Silent when the figure is stale
   * or missing, because the status-line writer may not be installed — a hint drawn
   * from a number nobody is publishing would be worse than no hint.
   */
  hint(): string | undefined {
    if (this.sessionId === undefined || this.policy === null) return undefined
    const budget = this.read(this.sessionId)
    if (!budget.found || budget.stale) return undefined

    const tokens = contextTokens(budget.budget.context)
    if (tokens === undefined) return undefined
    const threshold = thresholdFor(this.policy, budget.budget.context.window_size)
    if (tokens < threshold) {
      this.announced = false
      return undefined
    }
    if (this.announced) return undefined

    this.announced = true
    const cache = cacheSentence(budget.budget.prompt_cache, this.now())
    return [
      `[budget] Your context holds ${kTokens(tokens)} tokens, past the ${kTokens(threshold)} advisory mark.`,
      `At your next ${this.policy.boundary}, use agent_teleport to carry a handoff into a fresh session.`,
      ...(cache === undefined ? [] : [cache]),
    ].join(' ')
  }
}

/** Append a hint to a frame's content, keeping them visually separate. */
export const withHint = (content: string, hint: string | undefined): string =>
  hint === undefined ? content : `${content}\n\n${hint}`
