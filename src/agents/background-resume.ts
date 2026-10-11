import type { AgentEventRow } from '../broker/event-store.js'

/**
 * CC-336: a headless agent that ends its turn on a background task exits with no
 * report, because nothing wakes it when the task finishes. The supervisor resumes
 * it once with this message; only a second unreported exit reaches the spawner.
 * Denying `run_in_background` per profile is not possible: it is a Bash
 * parameter, not a tool name a `disallowedTools` pattern can match.
 */
export const BACKGROUND_RESUME_MESSAGE =
  'Your last turn ended on a background task with no report. Finish the work in the ' +
  'foreground, then send your Status report to your spawner.'

/** The `meta.cause` on the `agent_resumed` row the supervisor writes for this resume. */
export const BACKGROUND_RESUME = 'background-resume'

export type BackgroundResumeDecision = 'resume' | 'notice'

export function backgroundResumeDecision(facts: {
  pendingBackground: boolean
  resumedForBackgroundThisChain: boolean
}): BackgroundResumeDecision {
  return facts.pendingBackground && !facts.resumedForBackgroundThisChain ? 'resume' : 'notice'
}

/**
 * Whether the run that just ended was itself started by a background resume. Read
 * from the log, so the once-only rule survives a broker restart; any later spawn
 * or human/seat resume starts a new chain because its row is the newest.
 */
export function resumedForBackground(rows: readonly AgentEventRow[]): boolean {
  const last = rows.findLast(row => row.kind === 'agent_resumed')
  return last?.meta.cause === BACKGROUND_RESUME
}
