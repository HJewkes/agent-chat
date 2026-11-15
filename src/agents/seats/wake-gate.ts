/**
 * The model-free heartbeat gate's rule. A session that used to wake on a cron
 * instead arms `agent-chat heartbeat gate` as a Monitor, and every line the
 * gate prints is one model turn. So the rule is silence unless a watched value
 * changed, or nothing has been said for `maxQuietMs`.
 */

/** Watched key to its current value: a commit sha, `mtime:size`, `dir`, or `absent`. */
export type Fingerprint = Record<string, string>

export interface GateState {
  fp: Fingerprint
  /** When the gate last printed, or when it was seeded; the quiet clock runs from here. */
  lastEmitAtMs: number
}

export interface GateStepInput {
  prev: GateState | undefined
  fp: Fingerprint
  nowMs: number
  maxQuietMs: number
}

export interface GateStepResult {
  emit?: string
  state: GateState
}

/** Keys added, removed or changed between two fingerprints, sorted. */
export function diffNames(prev: Fingerprint, fp: Fingerprint): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(fp)])
  return [...keys].filter(key => prev[key] !== fp[key]).sort()
}

const shown = (value: string | undefined): string => value ?? 'absent'

function changeLine(prev: Fingerprint, fp: Fingerprint, names: string[]): string {
  return `changed: ${names.map(key => `${key} ${shown(prev[key])} -> ${shown(fp[key])}`).join('; ')}`
}

/** One poll. The first one only seeds, so arming the Monitor costs no wake. */
export function gateStep({ prev, fp, nowMs, maxQuietMs }: GateStepInput): GateStepResult {
  if (prev === undefined) return { state: { fp, lastEmitAtMs: nowMs } }
  const names = diffNames(prev.fp, fp)
  if (names.length > 0) return { emit: changeLine(prev.fp, fp, names), state: { fp, lastEmitAtMs: nowMs } }
  const quietMs = nowMs - prev.lastEmitAtMs
  if (quietMs >= maxQuietMs) {
    const minutes = Math.round(quietMs / 60_000)
    return { emit: `quiet: nothing changed in ${minutes} min`, state: { fp, lastEmitAtMs: nowMs } }
  }
  return { state: { fp, lastEmitAtMs: prev.lastEmitAtMs } }
}
