import type { Allocation } from './index.js'

/**
 * Why a strategy's last `release` of an allocation refused.
 *
 * `release` returns a bare boolean, which the composite and every strategy rely
 * on, so the reason travels beside it keyed by the allocation object rather than
 * widening that interface. Its own module so strategies can import it without a
 * runtime cycle back through the registry.
 */
const reasons = new WeakMap<Allocation, string>()

export const recordRefusal = (alloc: Allocation, reason: string): void => {
  reasons.set(alloc, reason)
}

export const clearRefusal = (alloc: Allocation): void => {
  reasons.delete(alloc)
}

export const refusalOf = (alloc: Allocation): string | undefined => reasons.get(alloc)
