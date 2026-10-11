import os from 'node:os'
import path from 'node:path'
import { resolveWorktreeOwnerReserve } from '../../config.js'
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

/**
 * The seat's implementers cap its active trees per repo; worktrees_per_repo_per_seat, when set, is a ceiling over that.
 * The owner reserve comes from agent-chat config; the charter's worktrees_left_free_per_repo is ignored (CC-872).
 */
function worktreeCaps(charter: CharterPolicy, implementers: number): SeatDispatch['worktrees'] {
  const ceiling = charter.defaults.worktrees_per_repo_per_seat
  const leftFreePerRepo = resolveWorktreeOwnerReserve()
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
  const pool = seatPool(charter, seat, name)
  if (!(seat.concurrency.implementers > 0))
    throw new Error(`${name} concurrency.implementers is unset or not positive; a seat needs a cap`)
  return {
    seat: name,
    prefix: seat.prefix,
    ...pool,
    repos: repoMap(seat, home),
    nonGitRepos: seat.repos.filter(r => r.git === false).map(r => expandHome(r.path, home)),
    caps: {
      implementers: seat.concurrency.implementers,
      reviewers: seat.concurrency.reviewers,
      planners: seat.concurrency.planners,
    },
    worktrees: worktreeCaps(charter, seat.concurrency.implementers),
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
