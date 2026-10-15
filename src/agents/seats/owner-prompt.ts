import { BACKGROUND_RESUME_MESSAGE } from '../background-resume.js'
import { EXTERNAL_HEARTBEAT_MESSAGE } from './heartbeat-external.js'
import { HEARTBEAT_MESSAGE, IDLE_LIVE_MESSAGE, PAUSE_WAKE_MESSAGE } from './heartbeat.js'
import { RESUME_MESSAGE } from './liveness.js'
import { renderRelaunchHandoff, renderTeleportHandoff } from './relaunch-handoff.js'
import { RunStartRefused, startRun, type RunStartDeps } from './run-start.js'
import { WAKE_MESSAGE } from './watchdog.js'

/**
 * CC-281 b: an owner's typed prompt starts a seat's new run (charter section 4), so the seat no
 * longer has to remember `seats run-start`. Everything agent-chat or Claude Code itself submits is
 * excluded; a prompt wrongly excluded only leaves the run meter as it was before this hook.
 */

/** The opening words of each prompt the watchdog, relaunch or teleport sends a seat. */
const firstWords = (text: string): string => text.split(/[:.]/, 1)[0] ?? text

const MACHINE_PREFIXES: readonly string[] = [
  HEARTBEAT_MESSAGE,
  EXTERNAL_HEARTBEAT_MESSAGE,
  PAUSE_WAKE_MESSAGE,
  firstWords(WAKE_MESSAGE),
  firstWords(RESUME_MESSAGE),
  firstWords(IDLE_LIVE_MESSAGE(0, 0)),
  firstWords(
    renderRelaunchHandoff({ root: '', seat: '', found: undefined, quietMinutes: 0, heartbeatSource: 'cron' }),
  ),
  firstWords(
    renderTeleportHandoff({
      root: '',
      seat: '',
      found: undefined,
      after: undefined,
      heartbeatSource: 'cron',
    }),
  ),
  BACKGROUND_RESUME_MESSAGE,
]

/** A channel delivery, task notification or loop sentinel opens with a tag no typed line starts with. */
const TAGGED = /^<[<a-z]/i

export function isOwnerPrompt(prompt: string): boolean {
  const text = prompt.trim()
  if (text === '' || TAGGED.test(text)) return false
  return !MACHINE_PREFIXES.some(prefix => text.startsWith(prefix))
}

/** The prompt of a UserPromptSubmit payload, or undefined for any other hook event. */
export function submittedPrompt(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as { hook_event_name?: unknown; prompt?: unknown }
    if (value.hook_event_name !== 'UserPromptSubmit' || typeof value.prompt !== 'string') return undefined
    return value.prompt
  } catch {
    return undefined
  }
}

export type OwnerPromptOutcome = 'not_owner' | 'started' | 'not_a_seat' | 'refused'

/**
 * Restarts `seat`'s run meter for an owner prompt without waiting on the watchdog's run lock: the
 * hook has seconds, and a lock the watchdog holds means its own pass is writing the meter anyway.
 */
export async function restartRunOnOwnerPrompt(
  deps: RunStartDeps,
  seat: string,
  prompt: string,
  onRefused: (err: unknown) => void,
): Promise<OwnerPromptOutcome> {
  if (!isOwnerPrompt(prompt)) return 'not_owner'
  try {
    await startRun({ ...deps, lockWaitMs: 0 }, seat)
    return 'started'
  } catch (err) {
    if (err instanceof RunStartRefused && err.code === 'unknown_seat') return 'not_a_seat'
    onRefused(err)
    return 'refused'
  }
}
