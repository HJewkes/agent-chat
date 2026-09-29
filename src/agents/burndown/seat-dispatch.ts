import os from 'node:os'
import path from 'node:path'
import type { PoolRule } from './budget-gate.js'
import { DEFAULT_NAME_PREFIX } from './plan.js'
import type { CharterPolicy, Policy, SeatPolicy } from './policy.js'

/** CC-205 D6: what the tick needs to dispatch for one seat, resolved from the charter and seat file. CLI-only. */

export interface SeatDispatch {
  seat: string
  prefix: string
  pool: PoolRule
  configDir: string
  /** Initiative slug to its checkouts, in the seat file's order. */
  repos: Record<string, string[]>
  caps: { implementers: number; reviewers: number; planners: number }
  worktrees: { perRepoPerSeat: number; leftFreePerRepo: number }
  excludedTags: string[]
  grants: string[]
}

const expandHome = (p: string, home: string): string =>
  p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p

function repoMap(seat: SeatPolicy, home: string): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const repo of seat.repos) {
    for (const slug of repo.initiatives) (map[slug] ??= []).push(expandHome(repo.path, home))
  }
  return map
}

function worktreeCaps(charter: CharterPolicy): SeatDispatch['worktrees'] {
  const { worktrees_per_repo_per_seat: perRepoPerSeat, worktrees_left_free_per_repo: leftFreePerRepo } =
    charter.defaults
  if (perRepoPerSeat === undefined || leftFreePerRepo === undefined)
    throw new Error('charter defaults lack worktrees_per_repo_per_seat or worktrees_left_free_per_repo')
  return { perRepoPerSeat, leftFreePerRepo }
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

/** Throws for a hub seat, a seat without a prefix, an unknown pool, or a config_dir that differs from the pool's. */
export function resolveSeatDispatch(policy: Policy, name: string, home = os.homedir()): SeatDispatch {
  const { charter } = policy
  const seat = policy.seats[name]
  if (seat === undefined) throw new Error(`${name} is not a seat`)
  if (seat.role === 'hub' || charter.hub === name)
    throw new Error(`${name} is the hub seat and dispatches nothing`)
  if (seat.prefix === undefined) throw new Error(`${name} has no agent-name prefix`)
  return {
    seat: name,
    prefix: seat.prefix,
    ...seatPool(charter, seat, name),
    repos: repoMap(seat, home),
    caps: { ...seat.concurrency },
    worktrees: worktreeCaps(charter),
    excludedTags: seat.excluded_tags,
    grants: seat.grants_extra,
  }
}

/** Every agent-name prefix the tick spawns under: `bd`, then each configured seat's; throws on a seat that cannot dispatch. */
export function tickPrefixes(seats: readonly string[], load: (seat: string) => Policy): string[] {
  const [first] = seats
  if (first === undefined) return [DEFAULT_NAME_PREFIX]
  const policy = load(first)
  return [DEFAULT_NAME_PREFIX, ...seats.map(s => resolveSeatDispatch(policy, s).prefix)]
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
