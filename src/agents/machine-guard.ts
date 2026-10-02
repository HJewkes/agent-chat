import { execFileSync } from 'node:child_process'
import os from 'node:os'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-406: a machine-wide spawn guard. The semaphore bounds the broker's standing
 * population and spawn-rate bounds churn per requester; neither sees the machine,
 * so several seats spawning at once drove load to 52 on 14 cores with swap at 84%.
 *
 * Memory pressure, not swap, is the gate: macOS keeps swap allocated long after
 * pressure ends, so swap used reads high on an idle machine. Swap is reported only.
 *
 * Pure decision over injectable readings. A reading that fails never refuses:
 * a broken reader would otherwise stop every seat on the machine.
 */

export const DEFAULT_MACHINE_HEADLESS_AGENTS = 10
export const DEFAULT_MACHINE_MEMORY_FREE_PERCENT = 15

export interface MachineLimits {
  headlessAgents: number
  /** Refuse below this share of memory free, as `kern.memorystatus_level` reports it. */
  memoryFreePercent: number
}

export type MemoryReading = { freePercent: number } | { error: string }

export type SwapReading = { usedBytes: number; totalBytes: number } | { error: string }

export interface MachineReadings {
  liveHeadless: number
  memory: MemoryReading
}

/** CC-445: stable causes of a machine-guard refusal; both clear as load drops. */
export type MachineRefusalCode = 'machine_headless_limit' | 'machine_memory_floor'

export type MachineDecision =
  { ok: true } | { ok: false; code: MachineRefusalCode; retryable: true; reason: string }

const LIVE_STATES = new Set(['spawning', 'live', 'detached'])

/** Headless agents whose process may still be running; detached counts, as it does in seat status. */
export function countLiveHeadless(agents: readonly AgentIdentity[]): number {
  return agents.filter(a => a.surface === 'headless' && LIVE_STATES.has(a.state)).length
}

/** Used share of swap in percent to one decimal, or null with no swap configured or no reading. */
export function swapPercent(swap: SwapReading): number | null {
  if ('error' in swap || swap.totalBytes <= 0) return null
  return Math.round((swap.usedBytes / swap.totalBytes) * 1000) / 10
}

/** `headless` is whether the requested spawn runs headless; only those count against the headless total. */
export function machineDecision(
  readings: MachineReadings,
  limits: MachineLimits,
  headless: boolean,
): MachineDecision {
  if (headless && readings.liveHeadless >= limits.headlessAgents) {
    return {
      ok: false,
      code: 'machine_headless_limit',
      retryable: true,
      reason:
        `machine guard: ${readings.liveHeadless} live headless agents machine-wide ` +
        `(limit ${limits.headlessAgents}, config machineHeadlessAgents); wait for one to exit`,
    }
  }
  const { memory } = readings
  if (!('error' in memory) && memory.freePercent < limits.memoryFreePercent) {
    return {
      ok: false,
      code: 'machine_memory_floor',
      retryable: true,
      reason:
        `machine guard: memory ${memory.freePercent}% free ` +
        `(floor ${limits.memoryFreePercent}%, config machineMemoryFreePercent); ` +
        'wait for memory pressure to ease before spawning',
    }
  }
  return { ok: true }
}

const sysctl = (name: string): string =>
  execFileSync('/usr/sbin/sysctl', ['-n', name], { encoding: 'utf8', timeout: 2000 })

/** Parses macOS `sysctl -n kern.memorystatus_level`, the percent of memory free. */
export function parseMemoryLevel(text: string): MemoryReading {
  const level = Number(text.trim())
  if (text.trim() === '' || !Number.isInteger(level) || level < 0 || level > 100)
    return { error: `unparsed kern.memorystatus_level: ${text.trim()}` }
  return { freePercent: level }
}

/** Only macOS is read; elsewhere the reading is an error and so never refuses. */
export function readMemoryFree(platform: NodeJS.Platform = process.platform): MemoryReading {
  if (platform !== 'darwin') return { error: `memory is not read on ${platform}` }
  try {
    return parseMemoryLevel(sysctl('kern.memorystatus_level'))
  } catch (err) {
    return { error: `sysctl kern.memorystatus_level failed: ${(err as Error).message}` }
  }
}

const UNIT_BYTES: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

function sizeOf(text: string, field: string): number | undefined {
  const match = new RegExp(`${field} = ([\\d.]+)([KMG])`).exec(text)
  if (!match) return undefined
  return Number.parseFloat(match[1] ?? '') * (UNIT_BYTES[match[2] ?? ''] ?? 1)
}

/** Parses macOS `sysctl -n vm.swapusage`: `total = 8192.00M  used = 7224.38M  free = 967.62M`. */
export function parseSwapUsage(text: string): SwapReading {
  const totalBytes = sizeOf(text, 'total')
  const usedBytes = sizeOf(text, 'used')
  if (totalBytes === undefined || usedBytes === undefined) return { error: `unparsed vm.swapusage: ${text}` }
  return { usedBytes, totalBytes }
}

export function readSwapUsage(platform: NodeJS.Platform = process.platform): SwapReading {
  if (platform !== 'darwin') return { error: `swap is not read on ${platform}` }
  try {
    return parseSwapUsage(sysctl('vm.swapusage'))
  } catch (err) {
    return { error: `sysctl vm.swapusage failed: ${(err as Error).message}` }
  }
}

export interface MachineStatus {
  headlessAgents: { live: number; limit: number }
  memoryFree: { percent: number | null; limit: number; error?: string }
  /** Reported only; no limit applies. */
  swap: { usedPercent: number | null; error?: string }
  fullSuiteSlots: { inUse: number; total: number }
}

const errorOf = (reading: { error: string } | object): { error?: string } =>
  'error' in reading ? { error: reading.error } : {}

export function machineStatus(
  readings: MachineReadings & { swap: SwapReading },
  limits: MachineLimits,
  slots: { inUse: number; total: number },
): MachineStatus {
  const { memory, swap } = readings
  return {
    headlessAgents: { live: readings.liveHeadless, limit: limits.headlessAgents },
    memoryFree: {
      percent: 'error' in memory ? null : memory.freePercent,
      limit: limits.memoryFreePercent,
      ...errorOf(memory),
    },
    swap: { usedPercent: swapPercent(swap), ...errorOf(swap) },
    fullSuiteSlots: slots,
  }
}

/** Parses `memory_pressure`: the line "System-wide memory free percentage: 41%". Null when the line is absent. */
export function parseMemoryPressure(text: string): number | null {
  const match = /System-wide memory free percentage:\s*(\d{1,3})%/.exec(text)
  const percent = match === null ? NaN : Number(match[1])
  return percent >= 0 && percent <= 100 ? percent : null
}

/** CC-431: free memory from `memory_pressure`; null when it is missing, fails or does not parse. */
export function readMemoryPressure(platform: NodeJS.Platform = process.platform): number | null {
  if (platform !== 'darwin') return null
  try {
    const out = execFileSync('/usr/bin/memory_pressure', [], { encoding: 'utf8', timeout: 5000 })
    return parseMemoryPressure(out)
  } catch {
    return null
  }
}

/** The five-minute load average. */
export const readLoad5 = (): number => Math.round((os.loadavg()[1] ?? 0) * 100) / 100
