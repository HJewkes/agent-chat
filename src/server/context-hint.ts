import { readBudget } from '../agents/budget.js'

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
 * "86%" is data. "At your next stopping point, teleport" is a thing to do.
 *
 * The cost of this being WRONG is the reason for the hysteresis below: a hint
 * that repeats becomes noise, and an agent that has learned to skim one line
 * will skim the one that mattered.
 */

/**
 * Crossing points, not a gradient.
 *
 * 70 is early enough that wrapping is still cheap and late enough not to fire on
 * ordinary work. 85 is where a handoff starts competing with the work itself for
 * room. 95 is the last point at which there is space to write a good handoff at
 * all — past it, the summarising is what runs out of context.
 */
export const THRESHOLDS = [70, 85, 95] as const

/** The highest threshold at or below `pct`, or undefined below the first. */
export function bandFor(pct: number): number | undefined {
  return [...THRESHOLDS].reverse().find(t => pct >= t)
}

const guidance = (band: number): string =>
  band >= 95
    ? 'Wrap now: past this point there is not enough room left to write a good handoff. ' +
      'Use agent_teleport with what you have.'
    : band >= 85
      ? 'At your next natural stopping point, use agent_teleport to carry a handoff into a ' +
        'fresh session rather than continuing here.'
      : 'Worth planning a stopping point: agent_teleport can carry a handoff into a fresh ' +
        'session when you reach one.'

/**
 * Tracks which band a session has already been told about, so each crossing is
 * announced once.
 *
 * Falling back down a band re-arms it. That is not a real case for a context
 * window, which only grows, but it IS real after a teleport: the successor is a
 * new session id with its own state, and an operator reading `/compact` output
 * mid-session should not be told nothing ever again.
 */
export class ContextHinter {
  private announced: number | undefined

  constructor(
    private readonly sessionId: string | undefined,
    private readonly read: typeof readBudget = readBudget,
  ) {}

  /**
   * The line to append to an outbound frame, or undefined for "say nothing".
   *
   * Silent unless a NEW band was crossed. Silent when the figure is stale or
   * missing, because the status-line writer may not be installed — a hint drawn
   * from a number nobody is publishing would be worse than no hint.
   */
  hint(): string | undefined {
    if (this.sessionId === undefined) return undefined
    const budget = this.read(this.sessionId)
    if (!budget.found || budget.stale) return undefined

    const pct = budget.budget.context.used_pct
    if (pct === undefined) return undefined
    const band = bandFor(pct)
    if (band === undefined) {
      this.announced = undefined
      return undefined
    }
    if (this.announced !== undefined && band <= this.announced) return undefined

    this.announced = band
    return `[budget] Your context is ${Math.round(pct)}% full. ${guidance(band)}`
  }
}

/** Append a hint to a frame's content, keeping them visually separate. */
export const withHint = (content: string, hint: string | undefined): string =>
  hint === undefined ? content : `${content}\n\n${hint}`
