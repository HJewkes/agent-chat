import { describe, expect, it } from 'vitest'
import { billingOrder, firstOpen } from '../agents/burndown/billed-pool.js'
import type { PoolGateResult } from '../agents/burndown/budget-gate.js'

/** CC-1145: the pools a seat's tick may bill, and the first open one. Pool names are synthetic. */

const POOLS = new Set(['pool-home', 'pool-fast', 'pool-spare'])

const open = (pool: string): PoolGateResult => ({ open: true, pool, sonnetOnly: false, reason: 'open' })
const closed = (pool: string): PoolGateResult => ({
  open: false,
  pool,
  reason: `BUDGET-PAUSE pool ${pool}: stopped`,
  gate: {} as Extract<PoolGateResult, { open: false }>['gate'],
})

describe('billingOrder', () => {
  it('tries the pick, then home, then the overflow pool in enforce mode', () => {
    const order = billingOrder({
      mode: 'enforce',
      home: 'pool-home',
      pick: ['pool-fast', 'pool-home'],
      overflow: 'pool-spare',
      pools: POOLS,
    })

    expect(order).toEqual(['pool-fast', 'pool-home', 'pool-spare'])
  })

  it.each(['shadow', 'off'] as const)('bills home alone in %s mode whatever the pick holds', mode => {
    const order = billingOrder({
      mode,
      home: 'pool-home',
      pick: ['pool-fast'],
      overflow: 'pool-spare',
      pools: POOLS,
    })

    expect(order).toEqual(['pool-home'])
  })

  it('drops a pick or overflow pool the charter does not name', () => {
    const order = billingOrder({
      mode: 'enforce',
      home: 'pool-home',
      pick: ['pool-gone'],
      overflow: 'pool-missing',
      pools: POOLS,
    })

    expect(order).toEqual(['pool-home'])
  })

  it('falls to home and overflow when the pick is empty', () => {
    const order = billingOrder({
      mode: 'enforce',
      home: 'pool-home',
      pick: [],
      overflow: 'pool-spare',
      pools: POOLS,
    })

    expect(order).toEqual(['pool-home', 'pool-spare'])
  })
})

describe('firstOpen', () => {
  it('bills the first pool whose gate is open', () => {
    const billed = firstOpen(['pool-home', 'pool-fast', 'pool-spare'], pool =>
      pool === 'pool-home' ? closed(pool) : open(pool),
    )

    expect(billed).toMatchObject({ open: true, pool: 'pool-fast' })
  })

  it('fails closed naming every pool when every gate is closed', () => {
    const billed = firstOpen(['pool-home', 'pool-fast', 'pool-spare'], closed)

    expect(billed.open).toBe(false)
    expect(billed.pool).toBe('pool-home')
    if (billed.open) return
    for (const pool of POOLS) expect(billed.reason).toContain(`pool ${pool}:`)
  })

  it('throws on an empty order', () => {
    expect(() => firstOpen([], open)).toThrow('no pool to bill')
  })
})
