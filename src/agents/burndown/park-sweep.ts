import type { AgentIdentity } from '../../protocol.js'
import { isReviewerSpawn } from '../reviewer-tree.js'
import type { SpawnReply } from './execute.js'
import type { Ledger } from './ledger.js'
import type { Roster } from './observe.js'
import { ledgerTreeHold } from './tree-hold.js'

/**
 * CC-1257: park-at-exit runs once, and most of its refusals are a claim still in `implementing`
 * when the agent exits. Nothing retried them, so those trees stayed on disk and filled the seat's
 * implementer count. Each tick re-tries the park; the broker's `park` rules still decide, so a
 * dirty, unpushed, occupied or fixing tree stays. The bound keeps the park's git and Shepherd
 * reads from stretching a tick.
 */
export const PARK_SWEEP_MAX = 8

/**
 * Spawned non-reviewer worktree agents of the tick's prefixes whose tree is on disk and no held
 * claim reads: exited ones oldest exit first, then detached ones oldest event first. CC-1064: a
 * detached row a previous broker left may never have its exit proven, so the park's own occupancy
 * and tenancy rules decide; ordering it last keeps a running one from crowding out exited trees.
 */
export function parkCandidates(
  roster: Roster,
  ledger: Ledger,
  prefixes: readonly string[],
  exists: (dir: string) => boolean,
): AgentIdentity[] {
  const running = new Set(
    roster.agents.filter(a => a.state === 'spawning' || a.state === 'live').map(a => a.name),
  )
  const seen = new Set<string>()
  return roster.agents
    .filter(a => isSweepable(a, prefixes) && !running.has(a.name))
    .sort(sweepOrder)
    .filter(a => {
      if (seen.has(a.name)) return false
      seen.add(a.name)
      return exists(a.cwd) && ledgerTreeHold(ledger, a.cwd) === undefined
    })
}

const sweepOrder = (a: AgentIdentity, b: AgentIdentity): number => {
  if (a.state !== b.state) return a.state === 'exited' ? -1 : 1
  return a.state === 'exited' ? (a.exitedAt ?? 0) - (b.exitedAt ?? 0) : a.lastEventAt - b.lastEventAt
}

const isSweepable = (agent: AgentIdentity, prefixes: readonly string[]): boolean =>
  (agent.state === 'exited' || agent.state === 'detached') &&
  agent.origin === 'spawned' &&
  agent.isolation === 'worktree' &&
  !isReviewerSpawn(agent.profile, agent.name) &&
  prefixes.some(p => agent.name.startsWith(`${p}-`))

export interface SweepResult {
  lines: string[]
  parked: number
  kept: number
  left: number
}

/** Parks up to `max` candidates in order; one refusal or throw is a kept line, never the end of the sweep. */
export async function parkSweep(
  candidates: readonly AgentIdentity[],
  park: (name: string) => Promise<SpawnReply>,
  max: number = PARK_SWEEP_MAX,
): Promise<SweepResult> {
  const tried = candidates.slice(0, max)
  const rest = candidates.slice(max).map(a => a.name)
  const lines: string[] = []
  let parked = 0
  for (const { name } of tried) {
    const reply = await park(name).catch((err: unknown): SpawnReply => ({
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }))
    if (reply.ok) parked++
    lines.push(reply.ok ? `parked ${name}` : `park kept ${name}: ${reply.reason ?? 'park refused'}`)
  }
  if (rest.length > 0) lines.push(`parkable ${rest.length} more: ${rest.join(', ')}`)
  return { lines, parked, kept: tried.length - parked, left: rest.length }
}

/** A dry run names what a real tick would try to park. */
export const describeCandidates = (candidates: readonly AgentIdentity[]): string[] =>
  candidates.length === 0
    ? []
    : [`would park ${candidates.length}: ${candidates.map(a => a.name).join(', ')}`]
