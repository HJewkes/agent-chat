/**
 * Ported from openrig, commit 3c8a20e3: packages/daemon/src/domain/health-detectors.ts
 * lines 378-455 (evaluateCoordination, evaluateWake) and the thresholds at
 * health-policy.ts:22. Copyright 2026 Mike Schwarz, Apache-2.0, modified: the
 * detectors are pure functions over plain observations instead of health
 * records and policy objects; the review carousel counts FIX_FIRST verdicts per
 * PR head, so an unmoved head stands in for candidateChanges = 0;
 * boundedAuthority is taken as false; the ceremony ratio needs an
 * implementer-profile run, else the finding is indeterminate; a wake is
 * redundant when the agent wrote no message after it, replacing
 * existingNextAction. The license text is in LICENSE.openrig beside this file.
 */

export const WASTE_THRESHOLDS = {
  ceremonyTransitions: 20,
  ceremonyRatio: 12,
  reviewReturns: 4,
  redundantWakes: 4,
} as const

export type WasteDetector = 'ceremony-amplification' | 'review-carousel' | 'redundant-wake'

export interface WasteFinding {
  detector: WasteDetector
  status: 'active' | 'indeterminate'
  task: string
  pr?: string
  head?: string
  counts: Record<string, number>
  threshold: string
}

export interface LineageObservation {
  task: string
  transitions: number
  mergedPrs: number
  hasImplementerRun: boolean
}

export interface VerdictObservation {
  task: string
  pr: string
  head: string
  verdict: 'MERGE' | 'FIX_FIRST'
}

export interface WakeObservation {
  /** One entry per wake of one agent, in time order. */
  task: string
  agent: string
  rescued: boolean
}

export function ceremonyAmplification(lineages: LineageObservation[]): WasteFinding[] {
  const { ceremonyTransitions, ceremonyRatio } = WASTE_THRESHOLDS
  const threshold = `transitions >= ${ceremonyTransitions} AND transitions / max(mergedPrs, 1) >= ${ceremonyRatio}`
  const findings: WasteFinding[] = []
  for (const l of lineages) {
    if (l.transitions < ceremonyTransitions) continue
    const counts = { transitions: l.transitions, mergedPrs: l.mergedPrs }
    if (!l.hasImplementerRun) {
      findings.push({
        detector: 'ceremony-amplification',
        status: 'indeterminate',
        task: l.task,
        counts,
        threshold,
      })
      continue
    }
    const ratio = l.transitions / Math.max(l.mergedPrs, 1)
    if (ratio >= ceremonyRatio) {
      findings.push({
        detector: 'ceremony-amplification',
        status: 'active',
        task: l.task,
        counts: { ...counts, ratio },
        threshold,
      })
    }
  }
  return findings
}

export function reviewCarousel(verdicts: VerdictObservation[]): WasteFinding[] {
  const returns = new Map<string, { task: string; pr: string; head: string; count: number }>()
  for (const v of verdicts) {
    if (v.verdict !== 'FIX_FIRST') continue
    const key = `${v.pr}\u0000${v.head}`
    const entry = returns.get(key) ?? { task: v.task, pr: v.pr, head: v.head, count: 0 }
    entry.count += 1
    returns.set(key, entry)
  }
  const threshold = `FIX_FIRST verdicts at one head >= ${WASTE_THRESHOLDS.reviewReturns}`
  return [...returns.values()]
    .filter(e => e.count >= WASTE_THRESHOLDS.reviewReturns)
    .map(e => ({
      detector: 'review-carousel' as const,
      status: 'active' as const,
      task: e.task,
      pr: e.pr,
      head: e.head,
      counts: { returns: e.count },
      threshold,
    }))
}

export function redundantWake(wakes: WakeObservation[]): WasteFinding[] {
  const byTask = new Map<string, { wakes: number; rescues: number }>()
  for (const w of wakes) {
    const entry = byTask.get(w.task) ?? { wakes: 0, rescues: 0 }
    entry.wakes += 1
    if (w.rescued) entry.rescues += 1
    byTask.set(w.task, entry)
  }
  const threshold = `wakes - rescues >= ${WASTE_THRESHOLDS.redundantWakes}`
  const findings: WasteFinding[] = []
  for (const [task, e] of byTask) {
    const redundant = e.wakes - e.rescues
    if (redundant < WASTE_THRESHOLDS.redundantWakes) continue
    findings.push({
      detector: 'redundant-wake',
      status: 'active',
      task,
      counts: { wakes: e.wakes, rescues: e.rescues, redundant },
      threshold,
    })
  }
  return findings
}
