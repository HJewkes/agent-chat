import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PSI_CRITICAL_AVG60,
  PSI_WARN_AVG60,
  parseMeminfoFree,
  parseMeminfoSwap,
  parsePsiMemory,
  psiPressureLevel,
  type ReadFile,
} from '../agents/machine-guard-linux.js'
import {
  machineDecision,
  machineStatus,
  readMemoryFree,
  readMemoryPressure,
  readPressureLevel,
  readSwapUsage,
  type MachineLimits,
} from '../agents/machine-guard.js'

/** CC-805: the machine guard on Linux, over fixture /proc text injected as the file reader. */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'proc-linux')
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')
const LIMITS: MachineLimits = { headlessAgents: 10, memoryFreePercent: 15 }
const KIB = 1024
const never = (): never => {
  throw new Error('exec must not run on linux')
}

/** A /proc stand-in: each path maps to a fixture file, and an unmapped path throws ENOENT as the kernel would. */
function procOf(files: Record<string, string>): ReadFile {
  return p => {
    const name = files[p]
    if (name === undefined) throw new Error(`ENOENT: no such file or directory, open '${p}'`)
    return fixture(name)
  }
}

const healthy = procOf({
  '/proc/meminfo': 'meminfo-healthy.txt',
  '/proc/pressure/memory': 'pressure-memory-healthy.txt',
})

describe('the /proc parsers', () => {
  it('reads free memory as MemAvailable over MemTotal', () => {
    expect(parseMeminfoFree(fixture('meminfo-healthy.txt'))).toEqual({ freePercent: 50 })
  })

  it('reads swap used as SwapTotal less SwapFree, in bytes', () => {
    expect(parseMeminfoSwap(fixture('meminfo-high-swap.txt'))).toEqual({
      usedBytes: 6_400_000 * KIB,
      totalBytes: 8_000_000 * KIB,
    })
  })

  it('reads a box with no swap as total zero, not an error', () => {
    expect(parseMeminfoSwap('SwapTotal:             0 kB\nSwapFree:              0 kB\n')).toEqual({
      usedBytes: 0,
      totalBytes: 0,
    })
  })

  it('reads PSI memory some avg60', () => {
    expect(parsePsiMemory(fixture('pressure-memory-high.txt'))).toEqual({ someAvg60: 22.75 })
  })

  it('reports malformed meminfo as an error for both memory and swap', () => {
    const text = fixture('meminfo-malformed.txt')

    expect([parseMeminfoFree(text), parseMeminfoSwap(text)]).toEqual([
      { error: expect.stringContaining('unparsed /proc/meminfo') },
      { error: expect.stringContaining('unparsed /proc/meminfo') },
    ])
  })

  it.each([
    ['a non-numeric avg60', fixture('pressure-memory-malformed.txt')],
    ['only a full line', 'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
    ['an empty file', ''],
    ['an avg60 over 100', 'some avg10=0.00 avg60=140.00 avg300=0.00 total=0\n'],
  ])('reports PSI with %s as an error', (_, text) => {
    expect(parsePsiMemory(text)).toEqual({ error: expect.stringContaining('unparsed /proc/pressure/memory') })
  })

  it('maps PSI onto the darwin pressure scale at the named thresholds', () => {
    const levels = [0, PSI_WARN_AVG60 - 0.01, PSI_WARN_AVG60, PSI_CRITICAL_AVG60 - 0.01, PSI_CRITICAL_AVG60]

    expect(levels.map(someAvg60 => psiPressureLevel({ someAvg60 }))).toEqual([1, 1, 2, 2, 4])
  })
})

describe('the readers on linux', () => {
  it('read a healthy box as free memory, low swap and normal pressure', () => {
    expect({
      memory: readMemoryFree('linux', never, healthy),
      swap: readSwapUsage('linux', never, healthy),
      stopMemory: readMemoryPressure('linux', healthy),
      pressure: readPressureLevel('linux', never, healthy),
    }).toEqual({
      memory: { freePercent: 50 },
      swap: { usedBytes: 400_000 * KIB, totalBytes: 8_000_000 * KIB },
      stopMemory: 50,
      pressure: 1,
    })
  })

  it('read low MemAvailable as low free memory for the spawn guard and the seat stop', () => {
    const low = procOf({ '/proc/meminfo': 'meminfo-low-available.txt' })

    expect([readMemoryFree('linux', never, low), readMemoryPressure('linux', low)]).toEqual([
      { freePercent: 10 },
      10,
    ])
  })

  it('read high PSI as the warn level the seat stop gates on', () => {
    const high = procOf({ '/proc/pressure/memory': 'pressure-memory-high.txt' })

    expect(readPressureLevel('linux', never, high)).toBe(2)
  })

  it('read a missing /proc/pressure/memory as no level, never as normal', () => {
    const noPsi = procOf({ '/proc/meminfo': 'meminfo-healthy.txt' })

    expect(readPressureLevel('linux', never, noPsi)).toBeNull()
  })

  it('carry the failed path when /proc/meminfo cannot be read', () => {
    const empty = procOf({})

    expect([readMemoryFree('linux', never, empty), readSwapUsage('linux', never, empty)]).toEqual([
      { error: expect.stringContaining('read /proc/meminfo failed: ENOENT') },
      { error: expect.stringContaining('read /proc/meminfo failed: ENOENT') },
    ])
  })

  it('report high swap in the machine status block from meminfo', () => {
    const proc = procOf({ '/proc/meminfo': 'meminfo-high-swap.txt' })
    const readings = {
      liveHeadless: 2,
      memory: readMemoryFree('linux', never, proc),
      swap: readSwapUsage('linux', never, proc),
    }

    expect(machineStatus(readings, LIMITS, { inUse: 0, total: 4 })).toMatchObject({
      memoryFree: { percent: 50, limit: 15 },
      swap: { usedPercent: 80 },
    })
  })

  it('refuse a spawn below the memory floor on low MemAvailable', () => {
    const memory = readMemoryFree('linux', never, procOf({ '/proc/meminfo': 'meminfo-low-available.txt' }))

    expect(machineDecision({ liveHeadless: 0, memory }, LIMITS, true)).toMatchObject({
      ok: false,
      code: 'machine_memory_floor',
      reason: expect.stringContaining('memory 10% free (floor 15%'),
    })
  })
})
