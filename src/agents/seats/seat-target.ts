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
  | {
      kind: 'resume-session'
      latest: SeatAgent
      sessionId: string
      cwd?: string
      stale: string[]
      /** The newest row the broker launched, whose profile is the one the seat was granted. */
      spawned?: SeatAgent
    }
  /** The newest row runs on another or an unrecorded account, so only a fresh launch is safe. */
  | { kind: 'fresh'; latest: SeatAgent; stale: string[]; spawned?: SeatAgent }

/** CC-959: a target the broker cannot bring back by name. */
export type RelaunchTarget = Exclude<SeatTarget, { kind: 'resume-by-name' }>

/** CC-959: what relaunching a dark seat on its own account needs. */
export interface SeatRelaunchPlan {
  target: RelaunchTarget
  account: SeatAccount
  /** What the seat is told when its latest session comes back. */
  message: string
  /** The brief a fresh launch starts on, when the session cannot come back. */
  fresh: string
  /** CC-1466: why the watchdog launches the seat, recorded on the spawn row. */
  reason: string
}

const newestFirst = (a: SeatAgent, b: SeatAgent): number =>
  (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0) || (b.generation ?? 1) - (a.generation ?? 1)

export const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)

/** Unknown when the row recorded no config dir, which an adopted row and a pre-CC-100 spawn both lack. */
function onAccount(agent: SeatAgent, account: SeatAccount | undefined): boolean | undefined {
  if (agent.configDir === undefined || agent.configDir === '') return undefined
  return account !== undefined && sameDir(agent.configDir, account.configDir)
}

/**
 * CC-1453: a row the broker launched leases the seat's name and resumes by name: a spawn, or a teleport
 * successor, which a hand-started session's successor is though it is recorded adopted.
 */
export const leasesName = (agent: SeatAgent): boolean =>
  agent.origin !== 'adopted' || agent.teleportFrom !== undefined

/** A row the roster carries is not retired, so every leasing row but the newest still holds the name. */
export function seatTarget(agents: SeatAgent[], seat: string, account: SeatAccount | undefined): SeatTarget {
  const [latest, ...older] = agents.filter(agent => agent.name === seat).sort(newestFirst)
  // No row: the broker has nothing to resume by name either, so nothing stale can wake.
  if (latest === undefined) return { kind: 'resume-by-name' }
  const stale = older.flatMap(agent =>
    leasesName(agent) && agent.agentId !== undefined ? [agent.agentId] : [],
  )
  const here = onAccount(latest, account)
  if (leasesName(latest) && here === true) return { kind: 'resume-by-name' }
  const spawned = [latest, ...older].find(agent => agent.origin !== 'adopted')
  const launched = spawned === undefined ? {} : { spawned }
  if (latest.origin === 'adopted' && here !== false && latest.sessionId !== undefined)
    return {
      kind: 'resume-session',
      latest,
      sessionId: latest.sessionId,
      ...(latest.cwd === undefined ? {} : { cwd: latest.cwd }),
      stale,
      ...launched,
    }
  return { kind: 'fresh', latest, stale, ...launched }
}

/**
 * CC-1053: an adopted row is minted for any session that registers the seat's name, so its session
 * counts as the seat's only when a spawned row of the seat (retired ones too) ran as that session id,
 * as a hand `claude --resume <seat session>` does.
 */
export function spawnLineage(latest: SeatAgent, rows: SeatAgent[]): boolean {
  const { sessionId } = latest
  if (sessionId === undefined || sessionId === '') return false
  return rows.some(row => row.name === latest.name && row.origin !== 'adopted' && row.sessionId === sessionId)
}

/** CC-1053: a session with no spawn lineage is not resumed; the seat starts fresh on its handoff. */
export function withoutLineage(target: RelaunchTarget, rows: SeatAgent[]): RelaunchTarget {
  if (target.kind !== 'resume-session' || spawnLineage(target.latest, rows)) return target
  const { latest, stale, spawned } = target
  return { kind: 'fresh', latest, stale, ...(spawned === undefined ? {} : { spawned }) }
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
