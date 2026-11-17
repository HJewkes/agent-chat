import type { AgentIdentity } from '../../protocol.js'
import { logEvent } from '../../broker/log.js'
import { launchedByBroker } from '../identity.js'

/**
 * TP-5768: one holder per policy seat, so a revive cannot produce a second steward. The name lease
 * (`AgentLog.nameHolder`) counts only identities the broker launched, which leaves two gaps: an
 * adopted (hand-started) holder does not block a spawn under its name, and a hand-started session
 * can register a seat name while the launched holder is detached. This closes both, behind a mode.
 */

export const SEAT_SINGLE_INSTANCE_MODES = ['off', 'shadow', 'enforce'] as const
export type SeatSingleInstanceMode = (typeof SEAT_SINGLE_INSTANCE_MODES)[number]

export type SingleInstanceRequest = 'spawn' | 'register-adopted' | 'register-agentId'

export interface SingleInstanceInput {
  name: string
  isPolicySeat: boolean
  holders: readonly Pick<AgentIdentity, 'agentId'>[]
  request: SingleInstanceRequest
  /** The requester's own identity, which never blocks itself. */
  self?: string | undefined
  /** The broker-derived predecessor of a teleport successor; a hand-over is always admitted. */
  teleportFrom?: string | undefined
}

export type SingleInstanceVerdict =
  { verdict: 'admit' } | { verdict: 'refuse'; reason: string; holder: string }

export function singleInstanceVerdict(input: SingleInstanceInput): SingleInstanceVerdict {
  if (!input.isPolicySeat || input.teleportFrom !== undefined) return { verdict: 'admit' }
  const holder = input.holders.find(h => h.agentId !== input.self)
  if (holder === undefined) return { verdict: 'admit' }
  return { verdict: 'refuse', reason: `seat name held by ${holder.agentId}`, holder: holder.agentId }
}

/**
 * Who holds `name` for the guard: every identity the lease already counts, plus an adopted one that
 * is attached. An adopted identity records no pid, so attachment (the fold's `live`, or a bound
 * connection) is the evidence its process is still there.
 */
export function seatHolders(
  roster: readonly AgentIdentity[],
  name: string,
  boundIds: ReadonlySet<string>,
): AgentIdentity[] {
  return roster.filter(
    a =>
      a.name === name &&
      a.state !== 'retired' &&
      !(a.state === 'exited' && a.exit?.failedToStart === true) &&
      (launchedByBroker(a) || a.state === 'live' || boundIds.has(a.agentId)),
  )
}

/** The refusal reason under `enforce`; `shadow` logs what it would refuse and admits; `off` does nothing. */
export function singleInstanceRefusal(
  mode: SeatSingleInstanceMode,
  input: () => SingleInstanceInput,
): string | undefined {
  if (mode === 'off') return undefined
  const asked = input()
  const decided = singleInstanceVerdict(asked)
  if (decided.verdict === 'admit') return undefined
  if (mode === 'enforce') return decided.reason
  logEvent('seat_single_instance_would_refuse', {
    name: asked.name,
    holder: decided.holder,
    request: asked.request,
  })
  return undefined
}
