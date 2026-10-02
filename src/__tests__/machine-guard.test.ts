import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  machineDecision,
  machineStatus,
  parseMemoryLevel,
  parseSwapUsage,
  readMemoryFree,
  readSwapUsage,
  type MachineLimits,
  type MemoryReading,
  type SwapReading,
} from '../agents/machine-guard.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-406: the machine-wide spawn guard, over mocked memory, swap and roster readings. */

const GIB = 1024 ** 3
const LIMITS: MachineLimits = { headlessAgents: 10, memoryFreePercent: 15 }
const free = (freePercent: number): MemoryReading => ({ freePercent })
const swapOf = (usedGib: number, totalGib = 8): SwapReading => ({
  usedBytes: usedGib * GIB,
  totalBytes: totalGib * GIB,
})

describe('the machine guard decision', () => {
  it('refuses a headless spawn at the headless total, naming the limit and the count', () => {
    const decision = machineDecision({ liveHeadless: 10, memory: free(60) }, LIMITS, true)

    expect(decision).toEqual({
      ok: false,
      code: 'machine_headless_limit',
      retryable: true,
      reason: expect.stringContaining('machine guard: 10 live headless agents'),
    })
    expect(decision.ok ? '' : decision.reason).toContain('limit 10, config machineHeadlessAgents')
  })

  it('allows a headless spawn one under the total', () => {
    expect(machineDecision({ liveHeadless: 9, memory: free(60) }, LIMITS, true)).toEqual({ ok: true })
  })

  it('lets a visible spawn through at the headless total', () => {
    expect(machineDecision({ liveHeadless: 12, memory: free(60) }, LIMITS, false)).toEqual({ ok: true })
  })

  it('refuses any spawn below the memory-free floor, naming the reading, the floor and the key', () => {
    const decision = machineDecision({ liveHeadless: 0, memory: free(9) }, LIMITS, false)

    expect(decision.ok ? '' : decision.reason).toContain(
      'memory 9% free (floor 15%, config machineMemoryFreePercent)',
    )
    expect(decision).toMatchObject({ ok: false, code: 'machine_memory_floor', retryable: true })
  })

  it('allows a spawn with memory free exactly at the floor', () => {
    expect(machineDecision({ liveHeadless: 0, memory: free(15) }, LIMITS, true)).toEqual({ ok: true })
  })

  it('fails open on a memory reading that errored', () => {
    const decision = machineDecision({ liveHeadless: 0, memory: { error: 'sysctl failed' } }, LIMITS, true)

    expect(decision).toEqual({ ok: true })
  })
})

describe('the machine status block', () => {
  it('reports high swap without flagging it while memory is free', () => {
    const status = machineStatus({ liveHeadless: 3, memory: free(35), swap: swapOf(7) }, LIMITS, {
      inUse: 1,
      total: 4,
    })

    expect(status).toEqual({
      headlessAgents: { live: 3, limit: 10 },
      memoryFree: { percent: 35, limit: 15 },
      swap: { usedPercent: 87.5 },
      fullSuiteSlots: { inUse: 1, total: 4 },
    })
  })

  it('carries each failed reader error and no figure', () => {
    const status = machineStatus(
      { liveHeadless: 0, memory: { error: 'no level' }, swap: { error: 'no swap' } },
      LIMITS,
      { inUse: 0, total: 4 },
    )

    expect([status.memoryFree, status.swap]).toEqual([
      { percent: null, limit: 15, error: 'no level' },
      { usedPercent: null, error: 'no swap' },
    ])
  })
})

describe('the readers', () => {
  it('parses kern.memorystatus_level as the percent free', () => {
    expect(parseMemoryLevel('35\n')).toEqual({ freePercent: 35 })
  })

  it.each(['', 'n/a', '135', '-1'])('reports a memorystatus level of %j as an error', text => {
    expect(parseMemoryLevel(text)).toEqual({ error: expect.stringContaining('unparsed') })
  })

  it('parses the evidence reading from sysctl vm.swapusage', () => {
    const text = 'total = 7341.00M  used = 5990.40M  free = 1350.60M  (encrypted)\n'

    expect(parseSwapUsage(text)).toEqual({ usedBytes: 5990.4 * 1024 ** 2, totalBytes: 7341 * 1024 ** 2 })
  })

  it('parses gigabyte and kilobyte swap units', () => {
    expect(parseSwapUsage('total = 2.00G  used = 512.00K  free = 1.99G')).toEqual({
      usedBytes: 512 * 1024,
      totalBytes: 2 * GIB,
    })
  })

  it('reports swap output it cannot parse as an error, not a reading', () => {
    expect(parseSwapUsage('vm.swapusage: unknown')).toEqual({ error: expect.stringContaining('unparsed') })
  })

  it('reports a platform other than macOS as unread for both readers', () => {
    expect([readMemoryFree('linux'), readSwapUsage('linux')]).toEqual([
      { error: 'memory is not read on linux' },
      { error: 'swap is not read on linux' },
    ])
  })
})

describe('agent spawn under the machine guard', () => {
  let h: RestartHarness | undefined
  let memory: MemoryReading
  let limits: MachineLimits

  const harness = (): RestartHarness => {
    h = startSupervisor({ machineGuard: { readMemoryFree: () => memory, limits: () => limits } })
    return h
  }

  afterEach(() => {
    h?.close()
    h = undefined
  })

  it('refuses the spawn that would pass the headless total and logs the refusal', async () => {
    memory = free(60)
    limits = { headlessAgents: 2, memoryFreePercent: 15 }
    const sup = harness()
    await sup.spawnAgent('mg-one')
    await sup.spawnAgent('mg-two')

    const third = await sup.spawnAgent('mg-three')

    expect(third).toEqual({
      ok: false,
      code: 'machine_headless_limit',
      retryable: true,
      reason: expect.stringContaining('2 live headless agents'),
    })
    const refused = sup.core.events.history(20).filter(r => r.kind === 'agent_spawn_refused')
    expect(refused.map(r => r.text)).toEqual([
      expect.stringContaining('limit 2, config machineHeadlessAgents'),
    ])
  })

  it('refuses a spawn under memory pressure and allows it once memory frees', async () => {
    memory = free(8)
    limits = LIMITS
    const sup = harness()

    const pressed = await sup.spawnAgent('mg-memory')
    memory = free(40)
    const freed = await sup.spawnAgent('mg-memory')

    expect(pressed).toEqual({
      ok: false,
      code: 'machine_memory_floor',
      retryable: true,
      reason: expect.stringContaining('machine guard: memory 8% free (floor 15%'),
    })
    expect(freed.ok).toBe(true)
  })

  it('spawns when the memory reader fails, and logs the failure', async () => {
    memory = { error: 'sysctl kern.memorystatus_level failed: boom' }
    limits = LIMITS
    const sup = harness()

    const outcome = await sup.spawnAgent('mg-open')

    expect(outcome.ok).toBe(true)
    const log = fs.readFileSync(path.join(sup.home, 'broker.log'), 'utf8')
    expect(log).toContain('"event":"machine_guard_reader_failed","reader":"memory"')
  })
})
