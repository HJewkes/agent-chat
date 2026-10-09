import { describe, expect, it } from 'vitest'
import { fromDeposit, type OwnerItem, type OwnerItemDeposit } from '@titan-design/owner-queue'
import type { Refusal } from '../agents/burndown/eligibility.js'
import type { SeatState } from '../agents/burndown/ledger.js'
import type { SeatOutcome } from '../agents/burndown/no-dispatch.js'
import { scopeExhausted, type OwnerQueuePort } from '../agents/burndown/seat-tick.js'

/**
 * CC-864: two ticks in a row with nothing eligible in scope file one scope-exhausted owner item, and none while it
 * is open. A stop or a full cap is not exhaustion.
 */

const NOW = new Date(2026, 1, 3, 12, 0)
const refused = (kind: Refusal['kind']): Refusal => ({ initiative: 'demo', kind, reason: 'synthetic' })
const refuseAll: SeatOutcome = {
  seat: 'alpha',
  dispatched: 0,
  refusals: [refused('trust'), refused('trust'), refused('claimed')],
}
const dispatching: SeatOutcome = { seat: 'alpha', dispatched: 1, refusals: [] }
const emptyScope: SeatOutcome = { seat: 'alpha', dispatched: 0, refusals: [] }
const stoppedBy = (kind: Refusal['kind']): SeatOutcome => ({
  seat: 'alpha',
  dispatched: 0,
  refusals: [refused(kind), refused('out-of-scope')],
})

/** The owner-queue fake port: deposits become open items, as `fromDeposit` files them. */
function fakePort() {
  const items: OwnerItem[] = []
  const port: OwnerQueuePort = {
    open: async () => items.filter(i => i.status === 'open'),
    deposit: async (d: OwnerItemDeposit) => {
      items.push(fromDeposit(d, NOW))
    },
  }
  return { port, items }
}

async function ticks(port: OwnerQueuePort, outcomes: SeatOutcome[]) {
  let states: Record<string, SeatState> = {}
  for (const outcome of outcomes) states = await scopeExhausted([outcome], states, NOW, port)
  return states
}

describe('scope-exhausted owner item', () => {
  it('files nothing on the first refuse-all tick', async () => {
    const { port, items } = fakePort()

    await ticks(port, [refuseAll])

    expect(items).toHaveLength(0)
  })

  it('files exactly one two-way item with the refusal counts on the second', async () => {
    const { port, items } = fakePort()

    await ticks(port, [refuseAll, refuseAll])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ door: 'two-way', seat: 'alpha', status: 'open' })
    expect(items[0]?.context).toContain('refusals trust 2, claimed 1')
    expect(items[0]?.recommended?.rationale).toBe(
      "Rec: let the seat run Discovery overflow from another seat's Overflow list, or wind down; nothing is eligible in scope",
    )
  })

  it('files nothing more while the item is still open', async () => {
    const { port, items } = fakePort()

    await ticks(port, [refuseAll, refuseAll, refuseAll, refuseAll])

    expect(items).toHaveLength(1)
  })

  it('restarts the count after a tick that dispatched', async () => {
    const { port, items } = fakePort()

    await ticks(port, [refuseAll, dispatching, refuseAll])

    expect(items).toHaveLength(0)
  })

  it('counts each seat apart', async () => {
    const { port, items } = fakePort()
    const beta = { ...refuseAll, seat: 'beta' }

    const states = await scopeExhausted([refuseAll, beta], {}, NOW, port)
    await scopeExhausted([refuseAll, { ...beta, dispatched: 1 }], states, NOW, port)

    expect(items.map(i => i.seat)).toEqual(['alpha'])
  })

  it('files an item when the seat has no open task in scope', async () => {
    const { port, items } = fakePort()

    await ticks(port, [emptyScope, emptyScope])

    expect(items).toHaveLength(1)
    expect(items[0]?.context).toContain('scope exhausted: no open task in scope')
  })

  it.each(['worktrees', 'slots', 'role-cap', 'budget', 'stop-line'] as const)(
    'files nothing while a %s stop holds the seat',
    async kind => {
      const { port, items } = fakePort()

      await ticks(port, [stoppedBy(kind), stoppedBy(kind), stoppedBy(kind)])

      expect(items).toHaveLength(0)
    },
  )

  it('restarts the count after a tick that met a stop', async () => {
    const { port, items } = fakePort()

    await ticks(port, [refuseAll, stoppedBy('budget'), refuseAll])

    expect(items).toHaveLength(0)
  })
})
