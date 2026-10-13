import type { AgentIdentity } from '../../protocol.js'
import { contextTokens, type BudgetRead } from '../budget.js'

/**
 * CC-317 b: each of a seat's agents with its context fill, and the seat's own, so a tick
 * answers "finished?", "past its retire threshold?" and "past teleport_k?" from `seats status` alone.
 */

export type AgentRole = 'implementer' | 'reviewer' | 'planner' | 'other'

const ROLES = ['implementer', 'reviewer', 'planner'] as const

/** The first role word in the profile, so a profile holding two counts once. */
export const roleOfProfile = (profile: string): AgentRole =>
  ROLES.find(role => profile.includes(role)) ?? 'other'

export interface SeatAgentRow {
  name: string
  role: AgentRole
  state: AgentIdentity['state']
  /** Thousands of context tokens; null without a reading. */
  contextK: number | null
  stale: boolean
  retireDue: boolean
}

export interface SelfContext {
  contextK: number | null
  stale: boolean
  teleportDue: boolean
}

interface Fill {
  contextK: number | null
  stale: boolean
}

function fillOf(read: BudgetRead): Fill {
  if (!read.found) return { contextK: null, stale: false }
  const tokens = contextTokens(read.budget.context)
  return { contextK: tokens === undefined ? null : Math.round(tokens / 1000), stale: read.stale }
}

const past = (contextK: number | null, limit: number | undefined): boolean =>
  contextK !== null && limit !== undefined && contextK > limit

const live = (agent: AgentIdentity): boolean => agent.state !== 'exited' && agent.state !== 'retired'

/** In name order. Only a live agent is read, since an exited one has nothing left to retire. */
export function agentRows(
  agents: readonly AgentIdentity[],
  roleOf: (agent: AgentIdentity) => AgentRole,
  contextOf: ((agent: AgentIdentity) => BudgetRead) | undefined,
  thresholdK: (agent: AgentIdentity) => number | undefined,
): SeatAgentRow[] {
  return [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(agent => {
      const role = roleOf(agent)
      const fill = contextOf === undefined || !live(agent) ? null : fillOf(contextOf(agent))
      const { contextK, stale } = fill ?? { contextK: null, stale: false }
      const limit = role === 'other' ? undefined : thresholdK(agent)
      return { name: agent.name, role, state: agent.state, contextK, stale, retireDue: past(contextK, limit) }
    })
}

/** Null when the caller's own session cannot be named. */
export function selfContext(read: BudgetRead | null, teleportK: number | undefined): SelfContext | null {
  if (read === null) return null
  const fill = fillOf(read)
  return { ...fill, teleportDue: past(fill.contextK, teleportK) }
}
