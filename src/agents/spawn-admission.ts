import type { AgentCostEstimate } from '../protocol.js'
import type { MemoryReading } from './machine-guard.js'

/**
 * CC-1671 S3: spawn admission, replacing the fixed 5-per-60s budget. The owner's case: a reviewer
 * costs little and a test runner a lot, and an agent that finishes in 10 s must not hold a window
 * for a minute.
 *
 * `SpawnSlots` is the burst guard: a requester may have so many launches in flight, and a slot
 * frees the moment its agent registers or exits. The semaphore still bounds the standing
 * population; this bounds how fast one requester can add to it.
 *
 * `predictedCostDecision` is the machine's side: a spawn is admitted when the current reading
 * plus the profile's p90 and what recent admissions have yet to show still clear the machine
 * guard's limits. A reading that failed never refuses, as in the machine guard.
 */

export const MAX_LAUNCHES_IN_FLIGHT = 5
/** A launch that neither registered nor exited stops counting, so a lost row cannot hold a slot. */
export const LAUNCH_SLOT_TTL_MS = 120_000
/** A registered agent's memory lags its registration, so its prediction stands this long. */
export const RESERVATION_MS = 60_000

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
  at: number
  registered: boolean
}

const NO_RESERVATION: Reservation = { rssKb: 0, cpuCores: 0 }

export class SpawnSlots {
  private readonly holds = new Map<string, Hold>()

  constructor(
    private readonly limit: number = MAX_LAUNCHES_IN_FLIGHT,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const now = this.now()
    for (const [agentId, hold] of this.holds) {
      const ttl = hold.registered ? RESERVATION_MS : LAUNCH_SLOT_TTL_MS
      if (now - hold.at >= ttl) this.holds.delete(agentId)
    }
  }

  private inFlight(requester: string): number {
    this.prune()
    return [...this.holds.values()].filter(h => h.requester === requester && !h.registered).length
  }

  /** Charges nothing: a slot is taken by {@link hold} once the spawn is about to launch. */
  check(requester: string): { ok: true } | { ok: false; reason: string } {
    const inFlight = this.inFlight(requester)
    if (inFlight < this.limit) return { ok: true }
    return {
      ok: false,
      reason:
        `${requester} has ${inFlight} launches in flight (limit ${this.limit}); ` +
        'retry when one registers or exits',
    }
  }

  hold(requester: string, agentId: string, reservation: Reservation = NO_RESERVATION): void {
    this.holds.set(agentId, { ...reservation, requester, at: this.now(), registered: false })
  }

  /** Frees the slot; the reservation stands until the agent's own use can show in a reading. */
  registered(agentId: string): void {
    const hold = this.holds.get(agentId)
    if (hold !== undefined) hold.registered = true
  }

  /** The agent is gone, so neither its slot nor its reservation stands. Safe to call twice. */
  release(agentId: string): void {
    this.holds.delete(agentId)
  }

  /** What admitted agents are predicted to use and no reading shows yet. */
  reserved(): Reservation {
    this.prune()
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
      `and recent spawns (floor ${limits.memoryFreePercent}%, config machineMemoryFreePercent); ` +
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
      `and recent spawns (limit ${limit}%, config machineCpuPressurePercent); retry when CPU eases`,
  }
}
