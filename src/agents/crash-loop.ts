import type { AgentIdentity, Launcher, WakeSource } from '../protocol.js'

/**
 * CC-1671 S4: an agent that keeps dying at launch is stopped where it is relaunched. A throttle
 * would only make the same loop slower and hold up every other spawn, so nothing here waits: the
 * count lives on the identity's own `agent_exited` rows, an automated relaunch of a marked
 * identity is refused on the spot, and every other spawn carries on.
 *
 * A launch counts when it ends in a non-zero exit or a signal within the window, or never
 * registered. An exit the broker caused and an inferred exit, which has no code, count as nothing,
 * so they end a streak. A resume by hand clears the mark and the streak.
 */

export const DEFAULT_CRASH_LOOP_SECONDS = 30
export const DEFAULT_CRASH_LOOP_LAUNCHES = 3
export const CRASH_LOOP = 'crash-loop'
export const CRASH_LOOP_REFUSAL = 'crash_looping'
export const STDERR_TAIL_MAX = 500

/** Either null turns the check off. */
export interface CrashLoopLimits {
  seconds: number | null
  launches: number | null
}

export interface LaunchEnd {
  code: number | null
  signal: string | null
  inferred?: boolean
  /** The agent never registered. */
  failed: boolean
  /** The broker ended it: a retire, a mode switch, an idle wake. */
  cancelled: boolean
  ranMs: number
  priorStreak: number
}

const crashed = ({ code, signal, inferred, failed, cancelled }: LaunchEnd): boolean => {
  if (cancelled || inferred === true) return false
  return code === null ? signal !== null || failed : code !== 0
}

/** The streak this exit leaves, 0 when it was no crash, and whether it reached the limit. */
export function crashStreak(end: LaunchEnd, limits: CrashLoopLimits): { streak: number; looped: boolean } {
  const { seconds, launches } = limits
  const counts =
    seconds !== null && launches !== null && crashed(end) && (end.failed || end.ranMs <= seconds * 1000)
  const streak = counts ? end.priorStreak + 1 : 0
  return { streak, looped: launches !== null && streak >= launches }
}

/** Who relaunched: anything with no automation behind it is a person or their agent asking by hand. */
export interface RelaunchOrigin {
  cause?: string
  forChild?: string
  launchedBy?: Launcher
  source?: WakeSource
}

export const isAutomaticRelaunch = ({ cause, forChild, launchedBy, source }: RelaunchOrigin): boolean =>
  cause !== undefined ||
  forChild !== undefined ||
  launchedBy !== undefined ||
  (source !== undefined && source !== 'console')

/** Why an automated relaunch of this identity must not run; undefined when it may. */
export function crashLoopRefusal(
  identity: Pick<AgentIdentity, 'name' | 'crashLoop'>,
  origin: RelaunchOrigin,
): string | undefined {
  if (identity.crashLoop === undefined || !isAutomaticRelaunch(origin)) return undefined
  return (
    `${identity.name} is crash-looping (${exitText(identity.crashLoop)}, ` +
    `${identity.crashLoop.count} launches in a row) and is not respawned; ` +
    'fix the cause, then resume it by hand, which clears the mark'
  )
}

const exitText = ({ code, signal }: { code: number | null; signal?: string }): string =>
  signal === undefined ? `last exit code ${code ?? 'unknown'}` : `last signal ${signal}`

/** The one notice a spawner gets; the output tail stays on the row. */
export const crashLoopNotice = (name: string, loop: NonNullable<AgentIdentity['crashLoop']>): string =>
  `${name} crashed at launch ${loop.count} times in a row (${exitText(loop)}) and will not be respawned. ` +
  '`agent-chat agent ls --json` has its output tail; a resume by hand clears the mark'

export const stderrTail = (output: string | undefined): string | undefined =>
  output?.trim().slice(-STDERR_TAIL_MAX) || undefined

/** The fold's reading of an `agent_exited` row's mark. */
export function crashLoopOf(
  meta: Readonly<Record<string, string>>,
  code: number | null,
  at: number,
): AgentIdentity['crashLoop'] {
  if (meta.crash_loop !== 'true') return undefined
  return {
    count: Number(meta.crash_streak),
    code,
    at,
    ...(meta.signal === undefined ? {} : { signal: meta.signal }),
    ...(meta.stderr_tail === undefined ? {} : { stderrTail: meta.stderr_tail }),
  }
}
