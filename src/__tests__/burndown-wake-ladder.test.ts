import { describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { deliverSeatEvents, WAKE_PROBE_EVERY, type SeatSender } from '../agents/burndown/seat-deliver.js'

const NOW = new Date('2026-02-03T04:05:06.000Z')

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'demo',
  spawnedAt: NOW.toISOString(),
  phase: 'parked',
  phaseAt: NOW.toISOString(),
  seat: 'alpha',
  agentId: 'id-1',
  notified: ['dispatched'],
  ...over,
})
const ledger = (...claims: Claim[]): Ledger => ({ ...EMPTY_LEDGER, claims })

type Reply = { ok: boolean; reason?: string; unknown?: true }

function fake(reply: () => Reply) {
  const seen = { sent: [] as string[], notices: [] as string[] }
  const open = async (): Promise<SeatSender> => ({
    send: async to => {
      seen.sent.push(to)
      return reply()
    },
    notify: async text => {
      seen.notices.push(text)
      return { ok: true }
    },
    close: () => undefined,
  })
  return { seen, open }
}

const refuse = (): Reply => ({ ok: false, reason: 'no active session named "alpha"' })

const tick = (after: Ledger, open: () => Promise<SeatSender>) =>
  deliverSeatEvents({ seats: ['alpha'], before: after, after, spawns: [] }, { open, log: () => {}, now: NOW })

async function ticks(n: number, start: Ledger, open: () => Promise<SeatSender>): Promise<Ledger> {
  let current = start
  for (let i = 0; i < n; i++) current = (await tick(current, open)).ledger
  return current
}

describe('wake ladder', () => {
  it('files one notice after three refused deliveries and none for a fourth tick', async () => {
    const { seen, open } = fake(refuse)

    const after3 = await ticks(3, ledger(claim()), open)
    await ticks(1, after3, open)

    expect(seen.sent).toEqual(['alpha', 'alpha', 'alpha'])
    expect(seen.notices).toHaveLength(1)
    expect(seen.notices[0]).toContain('alpha')
    expect(seen.notices[0]).toContain('no active session named "alpha"')
    expect(seen.notices[0]).toContain('1 parked')
  })

  it('probes a stopped seat once every few ticks without a second notice', async () => {
    const { seen, open } = fake(refuse)

    await ticks(3 + WAKE_PROBE_EVERY, ledger(claim()), open)

    expect(seen.sent).toHaveLength(4)
    expect(seen.notices).toHaveLength(1)
  })

  it('sends five stalled claims on one seat as one message and files at most one notice', async () => {
    const { seen, open } = fake(refuse)
    const stalled = ledger(
      ...[1, 2, 3, 4, 5].map(n =>
        claim({
          taskId: `T-${n}`,
          phase: 'implementing',
          stalledReason: `reason ${n}`,
          stallCode: 'phase-timeout',
        }),
      ),
    )

    await ticks(1, stalled, open)
    expect(seen.sent).toEqual(['alpha'])

    const after = await ticks(3, stalled, open)
    await ticks(2, after, open)
    expect(seen.notices).toHaveLength(1)
    expect(seen.notices[0]).toContain('5 stalled')
  })

  it('keeps the count across a restart', async () => {
    const first = fake(refuse)
    const twice = await ticks(2, ledger(claim()), first.open)
    const reloaded = JSON.parse(JSON.stringify(twice)) as Ledger

    const second = fake(refuse)
    await ticks(1, reloaded, second.open)

    expect(first.seen.notices).toHaveLength(0)
    expect(second.seen.notices).toHaveLength(1)
  })

  it('does not retry a delivery whose outcome is unknown', async () => {
    const { seen, open } = fake(() => ({
      ok: false,
      unknown: true,
      reason: 'broker did not answer send_result',
    }))

    await ticks(3, ledger(claim()), open)

    expect(seen.sent).toEqual(['alpha'])
    expect(seen.notices).toHaveLength(0)
  })

  it('clears the record on a success so the next failure starts at one', async () => {
    let answer: () => Reply = refuse
    const { seen, open } = fake(() => answer())
    const stopped = await ticks(3, ledger(claim()), open)
    answer = () => ({ ok: true })
    const probe = await ticks(WAKE_PROBE_EVERY, stopped, open)
    answer = refuse

    const next = await ticks(1, ledger(claim({ taskId: 'T-9', notified: ['dispatched'] })), open)
    const again = await ticks(
      2,
      { ...next, ...(probe.humanFiled ? { humanFiled: probe.humanFiled } : {}) },
      open,
    )

    expect(probe.wake).toBeUndefined()
    expect(probe.humanFiled ?? []).not.toContain('wake:alpha')
    expect(next.wake?.alpha?.failed).toBe(1)
    expect(again.wake?.alpha?.failed).toBe(3)
    expect(seen.notices).toHaveLength(2)
  })
})
