import { describe, expect, it } from 'vitest'
import { billingOrder, firstOpen } from '../agents/burndown/billed-pool.js'
import type { PoolGateResult } from '../agents/burndown/budget-gate.js'
import type { FundsMap } from '../agents/seats/charter.js'

/** CC-1145: the pools a seat's tick may bill, and the first open one. Pool names are synthetic. */

const POOLS = new Set(['pool-home', 'pool-fast', 'pool-spare'])
const FUNDS: FundsMap = { only: new Map(), fallback: [...POOLS], never: [] }
const FUNDED = { funds: FUNDS, initiatives: ['init-a'] }

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
      ...FUNDED,
    })

    expect(order.order).toEqual(['pool-fast', 'pool-home', 'pool-spare'])
  })

  it.each(['shadow', 'off'] as const)('bills home alone in %s mode whatever the pick holds', mode => {
    const order = billingOrder({
      mode,
      home: 'pool-home',
      pick: ['pool-fast'],
      overflow: 'pool-spare',
      pools: POOLS,
      ...FUNDED,
    })

    expect(order.order).toEqual(['pool-home'])
  })

  it('drops a pick or overflow pool the charter does not name', () => {
    const order = billingOrder({
      mode: 'enforce',
      home: 'pool-home',
      pick: ['pool-gone'],
      overflow: 'pool-missing',
      pools: POOLS,
      ...FUNDED,
    })

    expect(order.order).toEqual(['pool-home'])
  })

  it('falls to home and overflow when the pick is empty', () => {
    const order = billingOrder({
      mode: 'enforce',
      home: 'pool-home',
      pick: [],
      overflow: 'pool-spare',
      pools: POOLS,
      ...FUNDED,
    })

    expect(order.order).toEqual(['pool-home', 'pool-spare'])
  })
})

describe('billingOrder against the funds map', () => {
  const enforce = { mode: 'enforce' as const, home: 'pool-home', pools: POOLS }

  it('skips an overflow pool the funds map does not list', () => {
    const funds: FundsMap = { only: new Map(), fallback: ['pool-home', 'pool-fast'], never: [] }

    const order = billingOrder({
      ...enforce,
      pick: [],
      overflow: 'pool-spare',
      funds,
      initiatives: ['init-a'],
    })

    expect(order.order).toEqual(['pool-home'])
    expect(order.unfunded).toEqual(['pool pool-spare: not in the funds map for init-a'])
  })

  it('skips an unfunded pool the pick returned', () => {
    const funds: FundsMap = { only: new Map(), fallback: ['pool-home'], never: [] }

    const order = billingOrder({
      ...enforce,
      pick: ['pool-fast'],
      overflow: undefined,
      funds,
      initiatives: ['init-a'],
    })

    expect(order.order).toEqual(['pool-home'])
  })

  it('holds an initiative to its own funds entry over default', () => {
    const funds: FundsMap = {
      only: new Map([['init-health', ['pool-fast']]]),
      fallback: [...POOLS],
      never: [],
    }

    const order = billingOrder({
      ...enforce,
      pick: ['pool-spare'],
      overflow: 'pool-fast',
      funds,
      initiatives: ['init-health'],
    })

    expect(order.order).toEqual(['pool-fast'])
  })

  it('funds nothing for a human-only initiative', () => {
    const funds: FundsMap = { only: new Map(), fallback: [...POOLS], never: ['init-private'] }

    const order = billingOrder({
      ...enforce,
      pick: [],
      overflow: undefined,
      funds,
      initiatives: ['init-private'],
    })

    expect(order.order).toEqual([])
  })

  it('bills home alone in enforce mode when the charter has no funds map', () => {
    const order = billingOrder({
      ...enforce,
      pick: ['pool-fast'],
      overflow: 'pool-spare',
      funds: undefined,
      initiatives: [],
    })

    expect(order).toEqual({ order: ['pool-home'], unfunded: [] })
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
