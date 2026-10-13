import fs from 'node:fs'
import path from 'node:path'
import type { Action } from './advance.js'
import type { Step } from './execute.js'
import type { Claim } from './ledger.js'
import { repoForTask, type SeatDispatch } from './seat-dispatch.js'

/**
 * CC-946: the checkout a ready slice dispatches into. The slice plan's `repo`, else the one checkout that
 * holds the paths it owns, comes before the task's tags: a task is filed under one initiative while its
 * plan may put the work in another repo. A plan and an explicit `repo:` tag that disagree refuse.
 */

export type PathExists = (repo: string, relative: string) => boolean

export const diskPathExists: PathExists = (repo, relative) => fs.existsSync(path.join(repo, relative))

export type SliceRepo = { repo: string | undefined } | { ambiguous: string }

interface SliceAt {
  repo?: string | undefined
  owns?: readonly string[] | undefined
}

const literalPrefix = (pattern: string): string => pattern.split('*')[0]!.replace(/\/$/, '')

const matches = (repo: string, wanted: string): boolean => repo === wanted || path.basename(repo) === wanted

function plannedRepo(
  slice: SliceAt,
  candidates: readonly string[],
  exists: PathExists | undefined,
): string | undefined {
  if (slice.repo !== undefined) return candidates.find(r => matches(r, slice.repo!))
  const owns = (slice.owns ?? []).map(literalPrefix).filter(p => p !== '')
  if (exists === undefined || owns.length === 0) return undefined
  const holders = candidates.filter(repo => owns.some(p => exists(repo, p)))
  return holders.length === 1 ? holders[0] : undefined
}

export function sliceRepo(
  seat: SeatDispatch,
  initiative: string,
  tags: readonly string[],
  slice: SliceAt,
  exists?: PathExists,
): SliceRepo {
  const candidates = [
    ...new Set([...(seat.repos[initiative] ?? []), ...Object.values(seat.repos).flat()]),
  ].filter(r => !isInitiativeDir(r))
  const planned = plannedRepo(slice, candidates, exists)
  if (planned === undefined)
    return { repo: slice.repo === undefined ? taskRepo(seat, initiative, tags) : undefined }
  const tagged = tags.find(t => t.startsWith('repo:'))?.slice('repo:'.length)
  if (tagged !== undefined && !matches(planned, tagged))
    return {
      ambiguous: `the plan puts it in ${path.basename(planned)} but the task is tagged repo:${tagged}`,
    }
  return { repo: planned }
}

/**
 * CC-1228 (D17): an active-work initiative's `sources/` or `tasks/` directory holds notes, never a checkout.
 * A repo resolved there made the open-PR reader fail on every tick.
 */
export function isInitiativeDir(repo: string): boolean {
  const parts = repo.split(path.sep)
  const at = parts.indexOf('active-work')
  return at >= 0 && ['sources', 'tasks'].includes(parts[at + 2] ?? '')
}

/** `repoForTask`, with an initiative directory read as no repo. */
export function taskRepo(
  seat: SeatDispatch,
  initiative: string,
  tags: readonly string[],
): string | undefined {
  const repo = repoForTask(seat, initiative, tags)
  return repo === undefined || isInitiativeDir(repo) ? undefined : repo
}

/**
 * CC-1228 (D23): what to do with a queued slice whose repo its seat does not list. It moves to the first ticking
 * peer that lists the repo, else parks `no-repo` once; a parked slice is left alone until a seat lists its repo.
 * A slice with an agent or a PR is never touched. Undefined means the seat places it as usual.
 */
export type SliceHeal =
  { kind: 'rehome'; to: string } | { kind: 'park'; reason: string } | { kind: 'parked' } | { kind: 'unpark' }

export function healSlice(
  seat: SeatDispatch,
  peers: readonly SeatDispatch[],
  initiative: string,
  tags: readonly string[],
  claim: Claim,
  exists?: PathExists,
): SliceHeal | undefined {
  if (claim.agentName !== undefined || claim.pr !== undefined) return undefined
  const parked = claim.stallCode === 'no-repo'
  const placed = sliceRepo(seat, initiative, tags, claim, exists)
  if (!('ambiguous' in placed) && placed.repo !== undefined) return parked ? { kind: 'unpark' } : undefined
  const peer = peers.find(p => {
    const there = sliceRepo(p, initiative, tags, claim, exists)
    return !('ambiguous' in there) && there.repo !== undefined
  })
  if (peer !== undefined) return { kind: 'rehome', to: peer.seat }
  if (parked) return { kind: 'parked' }
  const why =
    'ambiguous' in placed
      ? placed.ambiguous
      : `lists no repo${claim.repo === undefined ? '' : ` ${claim.repo}`}`
  return {
    kind: 'park',
    reason:
      'ambiguous' in placed
        ? `${why}, and no ticking seat settles it`
        : `seat ${seat.seat} ${why} for ${initiative}, and no ticking seat does`,
  }
}

/** The tick applies the heals before its dispatches; a tick that healed nothing writes nothing. */
export const healSteps = (heals: readonly Action[] = []): Step[] =>
  heals.length === 0 ? [] : [{ kind: 'ledger', actions: [...heals] }]
