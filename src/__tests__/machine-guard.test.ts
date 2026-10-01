import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  machineDecision,
  parseSwapUsage,
  readSwapUsage,
  type MachineLimits,
  type SwapReading,
} from '../agents/machine-guard.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-406: the machine-wide spawn guard, over mocked swap and roster readings. */

const GIB = 1024 ** 3
const LIMITS: MachineLimits = { headlessAgents: 10, swapPercent: 85 }
const swapOf = (usedGib: number, totalGib = 8): SwapReading => ({
  usedBytes: usedGib * GIB,
  totalBytes: totalGib * GIB,
})

describe('the machine guard decision', () => {
  it('refuses a headless spawn at the headless total, naming the limit and the count', () => {
    const decision = machineDecision({ liveHeadless: 10, swap: swapOf(1) }, LIMITS, true)

    expect(decision).toEqual({ ok: false, reason: expect.stringContaining('10 live headless agents') })
    expect(decision.ok ? '' : decision.reason).toContain('limit 10')
  })

  it('allows a headless spawn one under the total', () => {
    expect(machineDecision({ liveHeadless: 9, swap: swapOf(1) }, LIMITS, true)).toEqual({ ok: true })
  })

  it('lets a visible spawn through at the headless total', () => {
    expect(machineDecision({ liveHeadless: 12, swap: swapOf(1) }, LIMITS, false)).toEqual({ ok: true })
  })

  it('refuses any spawn with swap past its share, naming the share and the limit', () => {
    const decision = machineDecision({ liveHeadless: 0, swap: swapOf(7) }, LIMITS, false)

    expect(decision.ok ? '' : decision.reason).toContain('swap 87.5% used (limit 85%')
  })

  it('allows a spawn with swap exactly at its share', () => {
    const swap = { usedBytes: 85, totalBytes: 100 }

    expect(machineDecision({ liveHeadless: 0, swap }, LIMITS, true)).toEqual({ ok: true })
  })

  it('fails open on a swap reading that errored or a machine with no swap', () => {
    const errored = machineDecision({ liveHeadless: 0, swap: { error: 'sysctl failed' } }, LIMITS, true)
    const noSwap = machineDecision({ liveHeadless: 0, swap: swapOf(0, 0) }, LIMITS, true)

    expect([errored, noSwap]).toEqual([{ ok: true }, { ok: true }])
  })
})

describe('the swap reader', () => {
  it('parses the evidence reading from sysctl vm.swapusage', () => {
    const text = 'total = 7341.00M  used = 5990.40M  free = 1350.60M  (encrypted)\n'

    expect(parseSwapUsage(text)).toEqual({ usedBytes: 5990.4 * 1024 ** 2, totalBytes: 7341 * 1024 ** 2 })
  })

  it('parses gigabyte and kilobyte units', () => {
    expect(parseSwapUsage('total = 2.00G  used = 512.00K  free = 1.99G')).toEqual({
      usedBytes: 512 * 1024,
      totalBytes: 2 * GIB,
    })
  })

  it('reports output it cannot parse as an error, not a reading', () => {
    expect(parseSwapUsage('vm.swapusage: unknown')).toEqual({ error: expect.stringContaining('unparsed') })
  })

  it('reports a platform other than macOS as unread', () => {
    expect(readSwapUsage('linux')).toEqual({ error: 'swap is not read on linux' })
  })
})

describe('agent spawn under the machine guard', () => {
  let h: RestartHarness | undefined
  let swap: SwapReading
  let limits: MachineLimits

  const harness = (): RestartHarness => {
    h = startSupervisor({ machineGuard: { readSwap: () => swap, limits: () => limits } })
    return h
  }

  afterEach(() => {
    h?.close()
    h = undefined
  })

  it('refuses the spawn that would pass the headless total and logs the refusal', async () => {
    swap = swapOf(1)
    limits = { headlessAgents: 2, swapPercent: 85 }
    const sup = harness()
    await sup.spawnAgent('mg-one')
    await sup.spawnAgent('mg-two')

    const third = await sup.spawnAgent('mg-three')

    expect(third).toEqual({ ok: false, reason: expect.stringContaining('2 live headless agents') })
    const refused = sup.core.events.history(20).filter(r => r.kind === 'agent_spawn_refused')
    expect(refused.map(r => r.text)).toEqual([
      expect.stringContaining('limit 2, config machineHeadlessAgents'),
    ])
  })

  it('refuses a spawn while swap is past its share and allows it once swap frees', async () => {
    swap = swapOf(7)
    limits = LIMITS
    const sup = harness()

    const over = await sup.spawnAgent('mg-swap')
    swap = swapOf(2)
    const freed = await sup.spawnAgent('mg-swap')

    expect(over).toEqual({ ok: false, reason: expect.stringContaining('swap 87.5% used') })
    expect(freed.ok).toBe(true)
  })

  it('spawns when the swap reader fails, and logs the failure', async () => {
    swap = { error: 'sysctl vm.swapusage failed: boom' }
    limits = LIMITS
    const sup = harness()

    const outcome = await sup.spawnAgent('mg-open')

    expect(outcome.ok).toBe(true)
    const log = fs.readFileSync(path.join(sup.home, 'broker.log'), 'utf8')
    expect(log).toContain('"event":"machine_guard_reader_failed"')
  })
})
