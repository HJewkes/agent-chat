import type { FundsMap } from '../seats/charter.js'
import { poolFunds, type PoolPickMode } from '../seats/pool-pick.js'
import type { PoolGateResult } from './budget-gate.js'

/**
 * CC-1145: which pool a seat's tick bills. In `enforce` the tick tries the pool pick's order, then the seat's home
 * pool, then its `overflow_pool`, keeping only pools the charter's `funds` map lets pay for the seat's work; in
 * `shadow` and `off` it bills home only, as before. Pure.
 */

export interface BillingOrderInput {
  mode: PoolPickMode
  home: string
  /** The pool pick's order, best first; empty when the pick had no pace file or no eligible pool. */
  pick: readonly string[]
  overflow: string | undefined
  /** The charter's pools; a name outside them is never billed. */
  pools: ReadonlySet<string>
  /** The charter's funds map; absent, `enforce` bills home only, as the broker's pick routes nothing without one. */
  funds: FundsMap | undefined
  /** The seat's initiatives; a pool must fund at least one, and each task is held to its own initiative. */
  initiatives: readonly string[]
}

export interface BillingOrder {
  order: string[]
  /** Why each pool the funds map left out of `order` was skipped. */
  unfunded: string[]
}

export function billingOrder(input: BillingOrderInput): BillingOrder {
  const { mode, home, pick, overflow, pools, funds: map, initiatives } = input
  if (mode !== 'enforce' || map === undefined) return { order: [home], unfunded: [] }
  const named = [...pick, home, overflow].filter(
    (name): name is string => name !== undefined && pools.has(name),
  )
  const candidates = [...new Set(named)]
  const scope = initiatives.length === 0 ? [undefined] : initiatives
  const funded = (pool: string) => scope.some(initiative => poolFunds(map, pool, initiative))
  return {
    order: candidates.filter(funded),
    unfunded: candidates
      .filter(pool => !funded(pool))
      .map(pool => `pool ${pool}: not in the funds map for ${initiatives.join(', ') || 'default'}`),
  }
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
