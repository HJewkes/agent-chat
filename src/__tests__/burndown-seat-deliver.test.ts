import { describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { deliverSeatEvents, type SeatSender } from '../agents/burndown/seat-deliver.js'

const NOW = new Date('2026-02-03T04:05:06.000Z')

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'demo',
  spawnedAt: NOW.toISOString(),
  phase: 'implementing',
  phaseAt: NOW.toISOString(),
  seat: 'alpha',
  agentId: 'id-1',
  notified: ['dispatched'],
  ...over,
})
const ledger = (...claims: Claim[]): Ledger => ({ ...EMPTY_LEDGER, claims })

function recorder(send: SeatSender['send'] = async () => ({ ok: true })) {
  const seen = { opened: 0, closed: 0, sent: [] as string[] }
  const open = async (): Promise<SeatSender> => {
    seen.opened += 1
    return {
      send: async (to, text) => {
        seen.sent.push(`${to}: ${text.split('\n').slice(1).join(' | ')}`)
        return send(to, text)
      },
      close: () => {
        seen.closed += 1
      },
    }
  }
  return { seen, open }
}

const deliver = (seats: string[], before: Ledger, after: Ledger, open: () => Promise<SeatSender>) =>
  deliverSeatEvents({ seats, before, after, spawns: [] }, { open, log: () => {}, now: NOW })

describe('deliverSeatEvents', () => {
  it('tells every seat over one sender and closes it once', async () => {
    const { seen, open } = recorder()
    const after = ledger(claim({ phase: 'parked' }), claim({ taskId: 'T-2', seat: 'beta', phase: 'parked' }))

    await deliver(['alpha', 'beta'], after, after, open)

    expect(seen).toEqual({ opened: 1, closed: 1, sent: ['alpha: parked T-1', 'beta: parked T-2'] })
  })

  it('closes the sender when a send throws, and leaves that seat due', async () => {
    const { seen, open } = recorder(async () => {
      throw new Error('broker did not answer send_result')
    })
    const after = ledger(claim({ phase: 'parked' }))

    const told = await deliver(['alpha'], after, after, open)

    expect(seen.closed).toBe(1)
    expect(told.lines).toEqual([
      'could not tell alpha of 1 event(s): broker did not answer send_result; retried next tick',
    ])
    expect(told.ledger.claims[0]?.notified).toEqual(['dispatched'])
  })

  it('fails every seat with the reason when the sender cannot open', async () => {
    const after = ledger(claim({ phase: 'parked' }))

    const told = await deliver(['alpha'], after, after, async () => {
      throw new Error('could not reach or start the agent-chat broker')
    })

    expect(told.lines[0]).toMatch(/^could not tell alpha of 1 event\(s\): could not reach/)
  })

  it('reports parked twice across park, answer and park again', async () => {
    const { seen, open } = recorder()
    const states: Claim['phase'][] = ['parked', 'implementing', 'parked']
    let current = ledger(claim({ phase: 'implementing' }))

    for (const phase of states) {
      const next = ledger({ ...(current.claims[0] as Claim), phase })
      current = (await deliver(['alpha'], current, next, open)).ledger
    }

    expect(seen.sent).toEqual(['alpha: parked T-1', 'alpha: parked T-1'])
    expect(current.claims[0]?.notified).toEqual(['dispatched', 'parked'])
  })

  it('does not open a sender when no event is due', async () => {
    const { seen, open } = recorder()
    const quiet = ledger(claim())

    await deliver(['alpha'], quiet, quiet, open)

    expect(seen.opened).toBe(0)
  })
})
