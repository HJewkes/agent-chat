import { describe, expect, it } from 'vitest'
import { CostTable, type ExitFootprint } from '../agents/agent-cost.js'
import {
  LAUNCH_SLOT_TTL_MS,
  predictedCostDecision,
  RESERVATION_MS,
  SpawnSlots,
  type AdmissionLimits,
  type AdmissionReadings,
} from '../agents/spawn-admission.js'

const GIB_KB = 1024 ** 2

const readings = (over: Partial<AdmissionReadings> = {}): AdmissionReadings => ({
  memory: { freePercent: 30 },
  totalMemoryKb: 100 * GIB_KB,
  cpuPressure: { someAvg60: 10 },
  cpuCount: 10,
  ...over,
})
const LIMITS: AdmissionLimits = { memoryFreePercent: 15, cpuPressurePercent: 40 }
const NONE = { rssKb: 0, cpuCores: 0 }

const runs = (profile: string, role: string, rssGib: number, coresEach: number): ExitFootprint[] =>
  Array.from({ length: 5 }, () => ({
    profile,
    role,
    footprint: { samples: 6, cpuSeconds: 60 * coresEach, rssPeakKb: rssGib * GIB_KB, childrenPeak: 1 },
  }))

const table = new CostTable([
  ...runs('bd-reviewer', 'reviewer', 1, 0.2),
  ...runs('test-runner', 'implementer', 8, 3),
])
const reviewer = table.estimate('bd-reviewer', 'reviewer')
const testRunner = table.estimate('test-runner', 'implementer')

/** Admits like the broker: each admission reserves its p90 against the next. */
function admit(cost: typeof reviewer, wave: number, at: AdmissionReadings): boolean[] {
  const slots = new SpawnSlots(wave, () => 0)
  return Array.from({ length: wave }, (_, i) => {
    const decision = predictedCostDecision(at, cost, slots.reserved(), LIMITS)
    if (decision.ok) slots.hold('seat', `a${i}`, { rssKb: cost.rssKb.p90, cpuCores: cost.cpuCores.p90 })
    return decision.ok
  })
}

describe('admission on predicted cost', () => {
  it('admits a reviewer burst and refuses a test-runner wave at the same headroom', () => {
    const headroom = readings({ memory: { freePercent: 30 }, cpuPressure: { someAvg60: 5 } })

    expect(admit(reviewer, 5, headroom)).toEqual([true, true, true, true, true])
    expect(admit(testRunner, 5, headroom)).toEqual([true, false, false, false, false])
  })

  it('names memory when the p90 RSS crosses the floor, retryably', () => {
    const decision = predictedCostDecision(
      readings({ memory: { freePercent: 20 } }),
      testRunner,
      NONE,
      LIMITS,
    )

    expect(decision).toMatchObject({ ok: false, code: 'machine_predicted_memory', retryable: true })
    expect(decision).toHaveProperty('reason', expect.stringContaining('12% after test-runner as implementer'))
  })

  it('names CPU when pressure plus the p90 share reaches the limit', () => {
    const decision = predictedCostDecision(
      readings({ cpuPressure: { someAvg60: 15 } }),
      table.estimate('test-runner', 'implementer'),
      { rssKb: 0, cpuCores: 2 },
      LIMITS,
    )

    expect(decision).toMatchObject({ ok: false, code: 'machine_predicted_cpu', retryable: true })
    expect(decision).toHaveProperty('reason', expect.stringContaining('config machineCpuPressurePercent'))
  })

  it('admits just under each limit', () => {
    const at = readings({ memory: { freePercent: 23 }, cpuPressure: { someAvg60: 9 } })

    expect(predictedCostDecision(at, testRunner, NONE, LIMITS)).toEqual({ ok: true })
  })

  it.each([
    ['a failed memory reading', { memory: { error: 'gone' } }],
    ['no total memory', { totalMemoryKb: 0 }],
    ['a failed CPU reading', { cpuPressure: { error: 'gone' } }],
    ['no PSI on this platform', { cpuPressure: null }],
    ['no CPU count', { cpuCount: 0 }],
  ] as [string, Partial<AdmissionReadings>][])('never refuses on %s', (_label, missing) => {
    const clearOtherwise = readings({
      memory: { freePercent: 90 },
      cpuPressure: { someAvg60: 0 },
      ...missing,
    })
    const huge = { ...testRunner, cpuCores: { median: 0, p90: 0 } }
    const heavyOnTheMissingResource =
      'memory' in missing || 'totalMemoryKb' in missing
        ? { ...huge, rssKb: { median: 0, p90: 1e12 } }
        : { ...testRunner, rssKb: { median: 0, p90: 0 }, cpuCores: { median: 0, p90: 1e6 } }

    expect(predictedCostDecision(clearOtherwise, heavyOnTheMissingResource, NONE, LIMITS)).toEqual({
      ok: true,
    })
  })

  it('skips the CPU check when its limit is off or absent', () => {
    const hot = readings({ cpuPressure: { someAvg60: 99 } })

    expect(predictedCostDecision(hot, reviewer, NONE, { memoryFreePercent: 15 })).toEqual({ ok: true })
    expect(
      predictedCostDecision(hot, reviewer, NONE, { memoryFreePercent: 15, cpuPressurePercent: null }),
    ).toEqual({ ok: true })
  })
})

describe('launch slots', () => {
  const clock = (): { now: () => number; advance: (ms: number) => void } => {
    let at = 0
    return { now: () => at, advance: ms => void (at += ms) }
  }

  it('refuses a requester at the limit and no other', () => {
    const slots = new SpawnSlots(1)
    slots.hold('seat', 'a1')

    expect(slots.check('seat')).toMatchObject({ ok: false })
    expect(slots.check('other')).toEqual({ ok: true })
  })

  it('frees the slot the moment the agent exits', () => {
    const slots = new SpawnSlots(1)
    slots.hold('seat', 'a1')

    slots.release('a1')

    expect(slots.check('seat')).toEqual({ ok: true })
  })

  it('frees the slot at registration but keeps the reservation until its time is up', () => {
    const { now, advance } = clock()
    const slots = new SpawnSlots(1, now)
    slots.hold('seat', 'a1', { rssKb: 100, cpuCores: 1 })

    slots.registered('a1')

    expect(slots.check('seat')).toEqual({ ok: true })
    expect(slots.reserved()).toEqual({ rssKb: 100, cpuCores: 1 })
    advance(RESERVATION_MS)
    expect(slots.reserved()).toEqual(NONE)
  })

  it('drops the reservation of a registered agent that exits', () => {
    const slots = new SpawnSlots(1)
    slots.hold('seat', 'a1', { rssKb: 100, cpuCores: 1 })
    slots.registered('a1')

    slots.release('a1')

    expect(slots.reserved()).toEqual(NONE)
  })

  it('lets go of a launch that never registers nor exits', () => {
    const { now, advance } = clock()
    const slots = new SpawnSlots(1, now)
    slots.hold('seat', 'a1')

    advance(LAUNCH_SLOT_TTL_MS)

    expect(slots.check('seat')).toEqual({ ok: true })
  })

  it('takes a registered or released id it never held as a no-op', () => {
    const slots = new SpawnSlots(1)

    slots.registered('ghost')
    slots.release('ghost')

    expect(slots.check('seat')).toEqual({ ok: true })
  })
})
