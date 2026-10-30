import type { AgentCostEstimate } from '../protocol.js'
import type { MemoryReading } from './machine-guard.js'

/**
 * CC-1671 S3: spawn admission, replacing the fixed 5-per-60s budget. The owner's case: a reviewer
 * costs little and a test runner a lot, and an agent that finishes in 10 s must not hold a window
 * for a minute. Nothing here is a window: every hold ends on a row, never on a clock. A crash loop
 * is stopped where the agent is relaunched, not by throttling every other spawn.
 *
 * `SpawnSlots` is the burst guard: a requester may have so many launches in flight, and a slot
 * frees the moment its agent registers or exits. A launch that does neither is ended at the attach
 * ceiling, so a slot cannot leak. The semaphore still bounds the standing population.
 *
 * `predictedCostDecision` is the machine's side: a spawn is admitted when the current reading
 * plus the profile's p90 and the p90 of the launches in flight still clear the machine guard's
 * limits. A reading that failed never refuses, as in the machine guard.
 */

export const MAX_LAUNCHES_IN_FLIGHT = 5

/** Stable causes of a predicted-cost refusal; each names the resource and clears as load drops. */
export type AdmissionRefusalCode = 'machine_predicted_memory' | 'machine_predicted_cpu'

export type AdmissionDecision =
  { ok: true } | { ok: false; code: AdmissionRefusalCode; retryable: true; reason: string }

export interface Reservation {
  rssKb: number
  cpuCores: number
}

interface Hold extends Reservation {
  requester: string
}

const NO_RESERVATION: Reservation = { rssKb: 0, cpuCores: 0 }

export class SpawnSlots {
  private readonly holds = new Map<string, Hold>()

  constructor(private readonly limit: number = MAX_LAUNCHES_IN_FLIGHT) {}

  /** Charges nothing: a slot is taken by {@link hold} once the spawn is about to launch. */
  check(requester: string): { ok: true } | { ok: false; reason: string } {
    const inFlight = [...this.holds.values()].filter(h => h.requester === requester).length
    if (inFlight < this.limit) return { ok: true }
    return {
      ok: false,
      reason:
        `${requester} has ${inFlight} launches in flight (limit ${this.limit}); ` +
        'retry when one registers or exits',
    }
  }

  hold(requester: string, agentId: string, reservation: Reservation = NO_RESERVATION): void {
    this.holds.set(agentId, { ...reservation, requester })
  }

  /** The agent registered or exited, so its launch is over. Safe to call twice. */
  release(agentId: string): void {
    this.holds.delete(agentId)
  }

  /** What the launches in flight are predicted to use. */
  reserved(): Reservation {
    const total = { ...NO_RESERVATION }
    for (const hold of this.holds.values()) {
      total.rssKb += hold.rssKb
      total.cpuCores += hold.cpuCores
    }
    return total
  }
}

/** CC-1670's CPU PSI reading; null on a platform without PSI. */
export type CpuPressure = { someAvg60: number } | { error: string } | null

export interface AdmissionReadings {
  memory: MemoryReading
  totalMemoryKb: number
  cpuPressure: CpuPressure
  cpuCount: number
}

export interface AdmissionLimits {
  memoryFreePercent: number
  /** Absent or null turns the CPU check off. */
  cpuPressurePercent?: number | null
}

type Predicted = Pick<AgentCostEstimate, 'profile' | 'role' | 'rssKb' | 'cpuCores'>

const oneDecimal = (value: number): number => Math.round(value * 10) / 10

const costOf = (cost: Predicted): string => `${cost.profile} as ${cost.role}`

/** Pure over its readings, so a test can hold the headroom still and vary the profile. */
export function predictedCostDecision(
  readings: AdmissionReadings,
  cost: Predicted,
  reserved: Reservation,
  limits: AdmissionLimits,
): AdmissionDecision {
  return (
    memoryDecision(readings, cost, reserved, limits) ??
    cpuDecision(readings, cost, reserved, limits) ?? {
      ok: true,
    }
  )
}

function memoryDecision(
  { memory, totalMemoryKb }: AdmissionReadings,
  cost: Predicted,
  reserved: Reservation,
  limits: AdmissionLimits,
): AdmissionDecision | undefined {
  if ('error' in memory || totalMemoryKb <= 0) return undefined
  const predicted = memory.freePercent - ((cost.rssKb.p90 + reserved.rssKb) / totalMemoryKb) * 100
  if (predicted >= limits.memoryFreePercent) return undefined
  return {
    ok: false,
    code: 'machine_predicted_memory',
    retryable: true,
    reason:
      `predicted memory: ${memory.freePercent}% free now, ${oneDecimal(predicted)}% after ${costOf(cost)} ` +
      `and launches in flight (floor ${limits.memoryFreePercent}%, config machineMemoryFreePercent); ` +
      'retry when memory frees',
  }
}

function cpuDecision(
  { cpuPressure, cpuCount }: AdmissionReadings,
  cost: Predicted,
  reserved: Reservation,
  { cpuPressurePercent: limit }: AdmissionLimits,
): AdmissionDecision | undefined {
  if (cpuPressure === null || 'error' in cpuPressure || cpuCount <= 0) return undefined
  if (limit === null || limit === undefined) return undefined
  const predicted = cpuPressure.someAvg60 + ((cost.cpuCores.p90 + reserved.cpuCores) / cpuCount) * 100
  if (predicted < limit) return undefined
  return {
    ok: false,
    code: 'machine_predicted_cpu',
    retryable: true,
    reason:
      `predicted CPU: pressure ${cpuPressure.someAvg60}% now, ${oneDecimal(predicted)}% after ${costOf(cost)} ` +
      `and launches in flight (limit ${limit}%, config machineCpuPressurePercent); retry when CPU eases`,
  }
}
