import { execFileSync } from 'node:child_process'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-406: a machine-wide spawn guard. The semaphore bounds the broker's standing
 * population and spawn-rate bounds churn per requester; neither sees the machine,
 * so several seats spawning at once drove load to 52 on 14 cores with swap at 84%.
 *
 * Pure decision over injectable readings. A reading that fails never refuses:
 * a broken swap reader would otherwise stop every seat on the machine.
 */

export const DEFAULT_MACHINE_HEADLESS_AGENTS = 10
export const DEFAULT_MACHINE_SWAP_PERCENT = 85

export interface MachineLimits {
  headlessAgents: number
  swapPercent: number
}

export type SwapReading = { usedBytes: number; totalBytes: number } | { error: string }

export interface MachineReadings {
  liveHeadless: number
  swap: SwapReading
}

export type MachineDecision = { ok: true } | { ok: false; reason: string }

const LIVE_STATES = new Set(['spawning', 'live', 'detached'])

/** Headless agents whose process may still be running; detached counts, as it does in seat status. */
export function countLiveHeadless(agents: readonly AgentIdentity[]): number {
  return agents.filter(a => a.surface === 'headless' && LIVE_STATES.has(a.state)).length
}

/** Used share of swap in whole percent, or null with no swap configured or no reading. */
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
      reason:
        `machine guard: ${readings.liveHeadless} live headless agents machine-wide ` +
        `(limit ${limits.headlessAgents}, config machineHeadlessAgents); wait for one to exit`,
    }
  }
  const swap = swapPercent(readings.swap)
  if (swap !== null && swap > limits.swapPercent) {
    return {
      ok: false,
      reason:
        `machine guard: swap ${swap}% used (limit ${limits.swapPercent}%, config machineSwapPercent); ` +
        'wait for memory to free before spawning',
    }
  }
  return { ok: true }
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

/** Only macOS is read; elsewhere the swap check reports an error and so never refuses. */
export function readSwapUsage(platform: NodeJS.Platform = process.platform): SwapReading {
  if (platform !== 'darwin') return { error: `swap is not read on ${platform}` }
  try {
    return parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 2000 }))
  } catch (err) {
    return { error: `sysctl vm.swapusage failed: ${(err as Error).message}` }
  }
}

export interface MachineStatus {
  headlessAgents: { live: number; limit: number }
  swap: { usedPercent: number | null; limit: number; error?: string }
  fullSuiteSlots: { inUse: number; total: number }
}

export function machineStatus(
  readings: MachineReadings,
  limits: MachineLimits,
  slots: { inUse: number; total: number },
): MachineStatus {
  const error = 'error' in readings.swap ? { error: readings.swap.error } : {}
  return {
    headlessAgents: { live: readings.liveHeadless, limit: limits.headlessAgents },
    swap: { usedPercent: swapPercent(readings.swap), limit: limits.swapPercent, ...error },
    fullSuiteSlots: slots,
  }
}
