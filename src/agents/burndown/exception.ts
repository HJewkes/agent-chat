import { z } from 'zod'
import type { Claim } from './ledger.js'

/** Why a claim stopped, which decides who may handle it. A gate-trip is an owner gate and is never triaged. */
export const EXCEPTION_CLASSES = ['stalled', 'failed', 'gate-trip'] as const
export type ExceptionClass = (typeof EXCEPTION_CLASSES)[number]

export const Route = z.enum(['owner', 'triage'])
export type Route = z.infer<typeof Route>

export type RouteConfig = { stalled: Route; failed: Route }

export interface RouteDecision {
  route: Route
  /** Set when a `triage` dial fell back to the owner. */
  reason?: string
}

/** A legacy row, stalled before classes were recorded, has none. */
export const classOf = (claim: Claim): ExceptionClass | undefined => claim.stalledClass

const owner = (reason?: string): RouteDecision =>
  reason === undefined ? { route: 'owner' } : { route: 'owner', reason }

/** Fails closed: only a known, non-gate class whose dial says `triage` and whose triage is ready leaves the owner. */
export function routeOf(cls: ExceptionClass | undefined, config: RouteConfig, ready: boolean): RouteDecision {
  if (cls === undefined || cls === 'gate-trip') return owner()
  if (config[cls] !== 'triage') return owner()
  return ready ? { route: 'triage' } : owner('triage is not ready')
}
