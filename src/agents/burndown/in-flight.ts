import type { DispatchRecord } from '../seats/dispatch-record.js'
import { isStalled, type Claim, type Phase } from './ledger.js'

/**
 * CC-630: the stage of each in-flight task, from the burndown claims and the seats' dispatch runs
 * (CC-328's fold). A task has one stage, the one from its latest sighting, so the stages sum to the
 * in-flight count. Pure.
 *
 * - A claim's stage follows its phase. A queued slice counts as building, and a stalled claim waits on the owner.
 * - The latest run on a task, across every seat, decides the runs' view of it. An open run (`dispatched` with
 *   no end row) goes by profile: a reviewer is in review, and anything else (implementers, planners) is
 *   building. A parked run is awaiting merge when its note carries a MERGE verdict, else awaiting the owner.
 *   Any other end state takes the task out of flight unless a held claim keeps it in.
 */

export type Stage = 'building' | 'inReview' | 'awaitingMerge' | 'awaitingOwner'

export const STAGES: readonly Stage[] = ['building', 'inReview', 'awaitingMerge', 'awaitingOwner']

interface Sighting {
  stage: Stage | undefined
  /** ISO time; compared as text, with an unknown time oldest. */
  at: string
}

const PHASE_STAGES: Record<Phase, Stage | undefined> = {
  queued: 'building',
  spawning: 'building',
  planning: 'building',
  implementing: 'building',
  parked: 'awaitingOwner',
  reviewing: 'inReview',
  'awaiting-merge': 'awaitingMerge',
  shepherding: 'awaitingMerge',
  done: undefined,
}

const claimSighting = (claim: Claim, now: Date): Sighting => ({
  stage: isStalled(claim, now) ? 'awaitingOwner' : PHASE_STAGES[claim.phase],
  at: claim.phaseAt,
})

const MERGE_VERDICT = /\bMERGE\b/

function runStage(run: DispatchRecord): Stage | undefined {
  if (run.outcome === 'dispatched') return /reviewer$/.test(run.profile ?? '') ? 'inReview' : 'building'
  if (run.outcome !== 'parked') return undefined
  return MERGE_VERDICT.test(String(run.note ?? '')) ? 'awaitingMerge' : 'awaitingOwner'
}

/** Keeps the later sighting per task; on a tie the earlier one stands. */
function keepLatest(into: Map<string, Sighting>, task: string, sighting: Sighting): void {
  const seen = into.get(task)
  if (seen === undefined || sighting.at > seen.at) into.set(task, sighting)
}

function runSightings(runs: readonly DispatchRecord[]): Map<string, Sighting> {
  const latest = new Map<string, Sighting>()
  for (const run of runs) {
    if (run.task !== null) keepLatest(latest, run.task, { stage: runStage(run), at: run.ts ?? '' })
  }
  return latest
}

/** Each in-flight task's stage; a task with no claim and no open or parked run is absent. */
export function inFlightStages(
  claims: readonly Claim[],
  runs: readonly DispatchRecord[],
  now: Date,
): Map<string, Stage> {
  const sightings = new Map<string, Sighting>()
  for (const claim of claims) {
    const sighting = claimSighting(claim, now)
    if (sighting.stage !== undefined) keepLatest(sightings, claim.taskId, sighting)
  }
  for (const [task, sighting] of runSightings(runs)) {
    if (sighting.stage === undefined && sightings.has(task)) continue
    keepLatest(sightings, task, sighting)
  }
  const stages = new Map<string, Stage>()
  for (const [task, { stage }] of sightings) if (stage !== undefined) stages.set(task, stage)
  return stages
}
