import type { PoolPickMode } from '../seats/pool-pick.js'
import type { PoolGateResult } from './budget-gate.js'

/**
 * CC-1145: which pool a seat's tick bills. In `enforce` the tick tries the pool pick's order, then the seat's home
 * pool, then its `overflow_pool`; in `shadow` and `off` it bills home only, as before. Pure.
 */

export interface BillingOrderInput {
  mode: PoolPickMode
  home: string
  /** The pool pick's order, best first; empty when the pick had no pace file or no eligible pool. */
  pick: readonly string[]
  overflow: string | undefined
  /** The charter's pools; a name outside them is never billed. */
  pools: ReadonlySet<string>
}

export function billingOrder({ mode, home, pick, overflow, pools }: BillingOrderInput): string[] {
  if (mode !== 'enforce') return [home]
  const named = [...pick, home, overflow].filter(
    (name): name is string => name !== undefined && pools.has(name),
  )
  return [...new Set(named)]
}

export type BilledPool =
  { open: true; pool: string; result: PoolGateResult } | { open: false; pool: string; reason: string }

/**
 * The first pool in `order` whose gate is open. With none open the result is closed on the order's first pool and
 * its reason lists every closed pool, so the seat fails closed. Throws on an empty order.
 */
export function firstOpen(order: readonly string[], gate: (pool: string) => PoolGateResult): BilledPool {
  const [first] = order
  if (first === undefined) throw new Error('no pool to bill')
  const reasons: string[] = []
  for (const pool of order) {
    const result = gate(pool)
    if (result.open) return { open: true, pool, result }
    reasons.push(result.reason)
  }
  return { open: false, pool: first, reason: reasons.join('; ') }
}
