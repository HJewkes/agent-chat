import fs from 'node:fs'
import path from 'node:path'
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
  const candidates = [...new Set([...(seat.repos[initiative] ?? []), ...Object.values(seat.repos).flat()])]
  const planned = plannedRepo(slice, candidates, exists)
  if (planned === undefined)
    return { repo: slice.repo === undefined ? repoForTask(seat, initiative, tags) : undefined }
  const tagged = tags.find(t => t.startsWith('repo:'))?.slice('repo:'.length)
  if (tagged !== undefined && !matches(planned, tagged))
    return {
      ambiguous: `the plan puts it in ${path.basename(planned)} but the task is tagged repo:${tagged}`,
    }
  return { repo: planned }
}
