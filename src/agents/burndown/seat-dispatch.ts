import os from 'node:os'
import path from 'node:path'
import type { PoolRule } from './budget-gate.js'
import type { CharterPolicy, Policy, SeatPolicy } from './policy.js'

/** CC-205 D6: what the tick needs to dispatch for one seat, resolved from the charter and seat file. CLI-only. */

export interface SeatDispatch {
  seat: string
  prefix: string
  pool: PoolRule
  configDir: string
  /** Initiative slug to its checkouts, in the seat file's order. */
  repos: Record<string, string[]>
  /** Checkouts marked `git: false` (CC-834): dispatch still uses them, the landed check never reads them. */
  nonGitRepos?: string[]
  caps: { implementers: number; reviewers: number; planners: number }
  /** `perRepoPerSeat` caps active trees (CC-279); `capName` says which setting set it, for the refusal. */
  worktrees: { perRepoPerSeat: number; capName: string; leftFreePerRepo: number }
  /** Checkout to its `wip_limit` override (CC-784); a checkout without one uses the default from `caps.reviewers`. */
  wipLimits: Record<string, number>
  excludedTags: string[]
  grants: string[]
}

export const expandHome = (p: string, home: string): string =>
  p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p

function repoMap(seat: SeatPolicy, home: string): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const repo of seat.repos) {
    for (const slug of repo.initiatives) (map[slug] ??= []).push(expandHome(repo.path, home))
  }
  return map
}

function wipLimits(seat: SeatPolicy, home: string): Record<string, number> {
  const limits: Record<string, number> = {}
  for (const repo of seat.repos)
    if (repo.wip_limit !== undefined) limits[expandHome(repo.path, home)] = repo.wip_limit
  return limits
}

/** The seat's implementers cap its active trees per repo; worktrees_per_repo_per_seat, when set, is a ceiling over that. */
function worktreeCaps(charter: CharterPolicy, implementers: number): SeatDispatch['worktrees'] {
  const { worktrees_per_repo_per_seat: ceiling, worktrees_left_free_per_repo: leftFreePerRepo } =
    charter.defaults
  if (leftFreePerRepo === undefined) throw new Error('charter defaults lack worktrees_left_free_per_repo')
  if (ceiling !== undefined && ceiling < implementers)
    return { perRepoPerSeat: ceiling, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo }
  return { perRepoPerSeat: implementers, capName: 'concurrency.implementers', leftFreePerRepo }
}

function seatPool(
  charter: CharterPolicy,
  seat: SeatPolicy,
  name: string,
): { pool: PoolRule; configDir: string } {
  const found = seat.pool === undefined ? undefined : charter.pools[seat.pool]
  if (found === undefined) throw new Error(`${name} names unknown pool ${seat.pool ?? '(none)'}`)
  if (seat.config_dir !== undefined && seat.config_dir !== found.config_dir)
    throw new Error(
      `${name} config_dir ${seat.config_dir} differs from pool ${seat.pool} (${found.config_dir})`,
    )
  return { pool: { ...found, name: seat.pool ?? '' }, configDir: found.config_dir }
}

/**
 * Throws for a seat with role hub, a seat without a prefix, an unknown pool, or a config_dir that differs from the pool's.
 * The charter's `hub:` names the charter and restart-window owner, not a non-dispatching seat (CC-775).
 */
export function resolveSeatDispatch(policy: Policy, name: string, home = os.homedir()): SeatDispatch {
  const { charter } = policy
  const seat = policy.seats[name]
  if (seat === undefined) throw new Error(`${name} is not a seat`)
  if (seat.role === 'hub') throw new Error(`${name} is the hub seat and dispatches nothing`)
  if (seat.prefix === undefined) throw new Error(`${name} has no agent-name prefix`)
  return {
    seat: name,
    prefix: seat.prefix,
    ...seatPool(charter, seat, name),
    repos: repoMap(seat, home),
    nonGitRepos: seat.repos.filter(r => r.git === false).map(r => expandHome(r.path, home)),
    caps: { ...seat.concurrency },
    worktrees: worktreeCaps(charter, seat.concurrency.implementers),
    wipLimits: wipLimits(seat, home),
    excludedTags: seat.excluded_tags,
    grants: seat.grants_extra,
  }
}

/** The checkout for a task: a `repo:<basename>` tag picks among the initiative's repos, else the first listed; undefined is `no-repo`. */
export function repoForTask(
  dispatch: SeatDispatch,
  initiative: string,
  tags: readonly string[],
): string | undefined {
  const repos = dispatch.repos[initiative] ?? []
  const wanted = tags.find(t => t.startsWith('repo:'))?.slice('repo:'.length)
  if (wanted === undefined) return repos[0]
  return repos.find(r => path.basename(r) === wanted)
}
