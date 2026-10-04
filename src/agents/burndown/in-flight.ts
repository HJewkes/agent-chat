import type { DispatchRecord } from '../seats/dispatch-record.js'
import { isStalled, type Claim, type Phase } from './ledger.js'

/**
 * CC-630: the stage of each in-flight task, from the burndown claims and the seats' dispatch runs
 * (CC-328's fold). A task has one stage, the one from its latest sighting, so the stages sum to the
 * in-flight count. Pure.
 *
 * - A claim's stage follows its phase. A queued slice counts as building, and a stalled claim waits on the owner.
 * - An open run on a task, across every seat, decides the runs' view of it, else the latest ended run; an open
 *   run older than `OPEN_RUN_MAX_AGE_DAYS` is a lost end row and is ignored. An open run (`dispatched`, with
 *   no later end row from the same agent) goes by profile: a reviewer is in review, and anything else (implementers, planners) is
 *   building. A parked run is awaiting merge when its note carries a MERGE verdict, else awaiting the owner.
 *   Any other end state takes the task out of flight unless a held claim keeps it in.
 */

export type Stage = 'building' | 'inReview' | 'awaitingMerge' | 'awaitingOwner'

export const STAGES: readonly Stage[] = ['building', 'inReview', 'awaitingMerge', 'awaitingOwner']

interface Sighting {
  stage: Stage | undefined
  /** Epoch ms; an unparseable time is -Infinity, so it is oldest. */
  at: number
}

/** An open run older than this is a lost end row, not live work: a seat's runs finish in hours. */
export const OPEN_RUN_MAX_AGE_DAYS = 7
const DAY_MS = 86_400_000

const toMs = (ts: string | null | undefined): number => {
  const ms = Date.parse(ts ?? '')
  return Number.isNaN(ms) ? -Infinity : ms
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
  at: toMs(claim.phaseAt),
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

const isOpen = (run: DispatchRecord): boolean => run.outcome === 'dispatched'

const isStaleOpen = (run: DispatchRecord, now: Date): boolean =>
  isOpen(run) && now.getTime() - toMs(run.ts) > OPEN_RUN_MAX_AGE_DAYS * DAY_MS

const agentKey = (run: DispatchRecord): string => `${run.task}\0${run.agent}`

/** Latest end time per task and agent: an end row closes that agent's open rows at or before it. */
function endTimes(runs: readonly DispatchRecord[]): Map<string, number> {
  const ends = new Map<string, number>()
  for (const run of runs) {
    if (!isOpen(run)) ends.set(agentKey(run), Math.max(ends.get(agentKey(run)) ?? -Infinity, toMs(run.ts)))
  }
  return ends
}

/**
 * Per task, the latest open run if it has one, else the latest ended run. A stale open run, or one its own
 * agent has since ended, is skipped.
 */
function runSightings(runs: readonly DispatchRecord[], now: Date): Map<string, Sighting> {
  const ends = endTimes(runs)
  const open = new Map<string, Sighting>()
  const ended = new Map<string, Sighting>()
  for (const run of runs) {
    if (run.task === null || isStaleOpen(run, now)) continue
    if (isOpen(run) && (ends.get(agentKey(run)) ?? -Infinity) >= toMs(run.ts)) continue
    keepLatest(isOpen(run) ? open : ended, run.task, { stage: runStage(run), at: toMs(run.ts) })
  }
  return new Map([...ended, ...open])
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
  for (const [task, sighting] of runSightings(runs, now)) {
    if (sighting.stage === undefined && sightings.has(task)) continue
    keepLatest(sightings, task, sighting)
  }
  const stages = new Map<string, Stage>()
  for (const [task, { stage }] of sightings) if (stage !== undefined) stages.set(task, stage)
  return stages
}
