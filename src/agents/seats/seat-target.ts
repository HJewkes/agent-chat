import path from 'node:path'
import type { SeatAccount } from './seat-account.js'
import type { SeatAgent } from './watchdog.js'

/**
 * CC-959: what bringing a dark seat back may act on. Pure.
 *
 * The broker resolves a name-keyed resume to the newest *spawned* row, so once the
 * owner starts the seat by hand (an adopted row) that resume wakes an older
 * generation, possibly on an account the seat file no longer names.
 */
export type SeatTarget =
  /** The newest row is spawned on the seat's account, which is the row the broker resumes by name. */
  | { kind: 'resume-by-name' }
  /** The newest row cannot be resumed by name; its session is the one to relaunch on the seat's account. */
  | { kind: 'resume-session'; latest: SeatAgent; sessionId: string; cwd?: string; stale: string[] }
  /** The newest row runs on another or an unrecorded account, so only a fresh launch is safe. */
  | { kind: 'fresh'; latest: SeatAgent; stale: string[] }

const newestFirst = (a: SeatAgent, b: SeatAgent): number =>
  (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0) || (b.generation ?? 1) - (a.generation ?? 1)

const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)

/** Unknown when the row recorded no config dir, which an adopted row and a pre-CC-100 spawn both lack. */
function onAccount(agent: SeatAgent, account: SeatAccount | undefined): boolean | undefined {
  if (agent.configDir === undefined || agent.configDir === '') return undefined
  return account !== undefined && sameDir(agent.configDir, account.configDir)
}

/** A row the roster carries is not retired, so every spawned one but the newest still holds the name. */
export function seatTarget(agents: SeatAgent[], seat: string, account: SeatAccount | undefined): SeatTarget {
  const [latest, ...older] = agents.filter(agent => agent.name === seat).sort(newestFirst)
  // No row: the broker has nothing to resume by name either, so nothing stale can wake.
  if (latest === undefined) return { kind: 'resume-by-name' }
  const stale = older.flatMap(agent =>
    agent.origin !== 'adopted' && agent.agentId !== undefined ? [agent.agentId] : [],
  )
  const here = onAccount(latest, account)
  if (latest.origin !== 'adopted' && here === true) return { kind: 'resume-by-name' }
  if (latest.origin === 'adopted' && here !== false && latest.sessionId !== undefined)
    return {
      kind: 'resume-session',
      latest,
      sessionId: latest.sessionId,
      ...(latest.cwd === undefined ? {} : { cwd: latest.cwd }),
      stale,
    }
  return { kind: 'fresh', latest, stale }
}

/** CC-959: how soon after the seat went dark a new session in its cwd reads as its pane carrying on. */
export const PANE_WINDOW_MS = 60_000

/** CC-959: how long a possible live pane holds the resume before the human is asked instead. */
export const PANE_HOLD_CAP_MS = 60 * 60_000

export interface PaneScan {
  agents: SeatAgent[]
  connected: string[]
  seat: string
  /** The seat's working directory; undefined when neither the seat file nor a seat row records one. */
  cwd: string | undefined
  darkSince: number
}

/**
 * CC-959: a connected, provisional, hand-started session that appeared in the seat's cwd
 * within a minute of the seat going dark, as a `/clear` or a restart in the owner's pane does.
 * It has not taken the seat's name yet, so the roster alone would call the seat dark.
 */
export function seatPane({ agents, connected, seat, cwd, darkSince }: PaneScan): SeatAgent | undefined {
  if (cwd === undefined) return undefined
  return agents.find(
    agent =>
      agent.name !== seat &&
      agent.origin === 'adopted' &&
      agent.provisionalName === true &&
      connected.includes(agent.name) &&
      agent.cwd !== undefined &&
      sameDir(agent.cwd, cwd) &&
      agent.spawnedAt !== undefined &&
      agent.spawnedAt >= darkSince &&
      agent.spawnedAt - darkSince <= PANE_WINDOW_MS,
  )
}
