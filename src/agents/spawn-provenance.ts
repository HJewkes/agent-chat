import { runGit, type GitRunner } from '../git.js'
import type { Allocation } from './isolation/index.js'

/**
 * CC-915: what a later task-to-eval exporter and throughput model need about an
 * agent that nothing else keeps. A squash merge and branch cleanup lose a
 * worktree's base commit for good, and a role read back out of a profile name is
 * a guess, so both are written on the agent's own rows while they are known.
 */

export const WORK_ROLES = ['implementer', 'reviewer', 'shepherd-review', 'planner', 'other'] as const

/** One of {@link WORK_ROLES}, or `fix-round-<n>` for Shepherd's n-th fix round. */
export type WorkRole = (typeof WORK_ROLES)[number] | `fix-round-${number}`

const FIX_ROUND_ROLE = /^fix-round-[1-9]\d*$/

export const isWorkRole = (value: string): value is WorkRole =>
  (WORK_ROLES as readonly string[]).includes(value) || FIX_ROUND_ROLE.test(value)

export const WORK_ROLE_CHOICES = `${WORK_ROLES.join(', ')}, fix-round-<n>`

/** Shepherd names each fix-round successor by appending `-s<N>` to its predecessor's name. */
const FIX_ROUND_SUFFIX = /(?:-s\d+)+$/

/** Shepherd's own reviewers are named `rv-<owner>-<repo>-<pr>`. */
const SHEPHERD_REVIEW = /^rv-/

/** The role a spawner did not state, read from the agent's name first and its profile second. */
export function inferWorkRole(profile: string, name: string): WorkRole {
  const rounds = FIX_ROUND_SUFFIX.exec(name)?.[0].match(/-s\d+/g)?.length
  if (rounds !== undefined) return `fix-round-${rounds}`
  if (SHEPHERD_REVIEW.test(name) && profile.includes('reviewer')) return 'shepherd-review'
  if (profile.includes('reviewer') || /-review(?:-|$)/.test(name)) return 'reviewer'
  if (profile.includes('planner')) return 'planner'
  if (profile.includes('implementer')) return 'implementer'
  return 'other'
}

const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

/** `owner/name` of a GitHub remote URL; undefined for any other remote. */
export const githubRepoOf = (url: string): string | undefined => GITHUB_REMOTE.exec(url.trim())?.[1]

/**
 * The configured origin URL, not `remote get-url`'s: that one applies `insteadOf`
 * rewrites, which turn a GitHub URL into a mirror path with no owner in it.
 */
async function originRepo(gitRoot: string, git: GitRunner): Promise<string | undefined> {
  const url = await git(['config', '--get', 'remote.origin.url'], gitRoot)
  return url === null ? undefined : githubRepoOf(url)
}

/**
 * The worktree half of the provenance, as row meta: repo, branch and base. An
 * adopted worktree has a branch but no base this spawn cut it from, so it records
 * none rather than guessing one; a non-worktree allocation records nothing.
 */
export async function worktreeProvenance(
  allocation: Allocation,
  git: GitRunner = runGit,
): Promise<Record<string, string>> {
  const ref = allocation.ref
  if (ref?.gitRoot === undefined) return {}
  const repo = await originRepo(ref.gitRoot, git)
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(ref.branch === undefined ? {} : { branch: ref.branch }),
    ...(ref.base && ref.base_ref ? { base_sha: ref.base, base_ref: ref.base_ref } : {}),
    ...(ref.reattached === undefined ? {} : { reattached: ref.reattached }),
  }
}

/**
 * A burndown spawn always runs a task, so one without an id is a caller bug that
 * would leave the run unattributable; a role outside the vocabulary is refused
 * rather than recorded, since the exporter groups by it.
 */
export function assignmentRefusal(req: {
  task?: string
  workRole?: string
  spawnedAs?: string
}): string | undefined {
  if (req.workRole !== undefined && !isWorkRole(req.workRole))
    return `role must be one of: ${WORK_ROLE_CHOICES}; got "${req.workRole}"`
  if (req.spawnedAs === 'burndown' && (req.task ?? '').trim() === '')
    return 'a burndown spawn needs a task id; send `task` with the frame'
  return undefined
}

/** The task and role half, as row meta; `work_role_inferred` marks a role nobody stated. */
export function assignmentMeta(
  req: { task?: string; workRole?: string; name: string },
  profile: string,
): Record<string, string> {
  return {
    ...(req.task === undefined ? {} : { task: req.task }),
    ...(req.workRole === undefined
      ? { work_role: inferWorkRole(profile, req.name), work_role_inferred: 'true' }
      : { work_role: req.workRole }),
  }
}
