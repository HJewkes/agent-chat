import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runGit, type GitRunner } from '../git.js'
import type { SurfaceName } from '../protocol.js'
import { githubRepoOf } from './spawn-provenance.js'
import type { AgentProfile } from './types.js'

/**
 * CC-398: a brief that asks for a tool the agent cannot use is found out
 * mid-run, after the spawn has paid for a session. Linting the caller's brief at
 * spawn refuses it while the spawner can still reword it. Only the caller's
 * brief is linted: the broker's own return contract names ScheduleWakeup in a
 * "never" sentence.
 */

export type RepoVisibility = 'public' | 'private' | 'internal' | 'unknown'

export interface BriefLintInput {
  brief: string
  profile: Pick<AgentProfile, 'name' | 'disallowedTools'>
  surface: SurfaceName
  repoVisibility: RepoVisibility
}

export interface BriefLint {
  refusal?: string
  warnings: string[]
}

/** A headless agent exits at turn end, so a wakeup it schedules never fires. */
const HEADLESS_UNUSABLE = ['ScheduleWakeup', 'CronCreate']

const NEGATION = /\b(?:never|not|don't|dont|no|without)\b/i

const SYNTHETIC_LINE = /synthetic/i

const BASH_PATTERN = /^Bash\((.+):\*\)$/

/**
 * Only CamelCase tool names are matched bare: `Write`, `Edit` and `Bash` are
 * also ordinary English words, so a brief saying "Write the handoff" would be
 * refused for a profile that denies Write.
 */
const CAMEL_CASE_TOOL = /^[A-Z][a-z]+[A-Z]\w*$/

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const sentencesOf = (brief: string): string[] => brief.split(/[.!?;\n]+/)

/** A brief that needs no visibility read: the synthetic-data line is already there. */
export const mentionsSyntheticData = (brief: string): boolean => SYNTHETIC_LINE.test(brief)

/** True when some sentence names the term and carries no negation. */
function asksFor(brief: string, term: string): boolean {
  const mention = new RegExp(`(?<![\\w-])${escape(term)}(?![\\w-])`)
  return sentencesOf(brief).some(sentence => mention.test(sentence) && !NEGATION.test(sentence))
}

/** The literal a deny entry blocks: a CamelCase tool name, or the command inside `Bash(<command>:*)`. */
function deniedTerm(entry: string): string | undefined {
  const command = BASH_PATTERN.exec(entry)?.[1]
  if (command !== undefined) return command
  return CAMEL_CASE_TOOL.test(entry) ? entry : undefined
}

function deniedToolRefusal(input: BriefLintInput): string | undefined {
  const { brief, profile, surface } = input
  for (const entry of profile.disallowedTools ?? []) {
    const term = deniedTerm(entry)
    if (term !== undefined && asksFor(brief, term))
      return `brief asks ${profile.name} to use ${term}, which the profile denies (${entry}); reword the brief`
  }
  if (surface !== 'headless') return undefined
  const unusable = HEADLESS_UNUSABLE.find(tool => asksFor(brief, tool))
  return unusable === undefined
    ? undefined
    : `brief asks ${profile.name} to use ${unusable}, which a headless agent cannot use; reword the brief`
}

export function lintBrief(input: BriefLintInput): BriefLint {
  const refusal = deniedToolRefusal(input)
  const warnings =
    input.repoVisibility === 'public' && !mentionsSyntheticData(input.brief)
      ? ['brief targets a public repo but has no synthetic-data line; real data could land in the PR']
      : []
  return { ...(refusal === undefined ? {} : { refusal }), warnings }
}

export type GhRunner = (args: readonly string[]) => Promise<string>

const VISIBILITY_TIMEOUT_MS = 5000

const runGh: GhRunner = async args =>
  (await promisify(execFile)('gh', [...args], { timeout: VISIBILITY_TIMEOUT_MS, encoding: 'utf8' })).stdout

const asVisibility = (text: string): RepoVisibility => {
  const value = text.trim()
  return value === 'public' || value === 'private' || value === 'internal' ? value : 'unknown'
}

/**
 * The visibility of the GitHub repo a spawn's cwd belongs to, cached per repo
 * for the broker's life. Any failure is `unknown`, which warns about nothing.
 */
export function repoVisibilityReader(
  git: GitRunner = runGit,
  gh: GhRunner = runGh,
): (cwd: string) => Promise<RepoVisibility> {
  const cache = new Map<string, Promise<RepoVisibility>>()
  const lookup = (repo: string): Promise<RepoVisibility> =>
    gh(['api', `repos/${repo}`, '--jq', '.visibility']).then(asVisibility, () => 'unknown' as const)
  return async cwd => {
    const url = await git(['config', '--get', 'remote.origin.url'], cwd).catch(() => null)
    const repo = url === null ? undefined : githubRepoOf(url)
    if (repo === undefined) return 'unknown'
    if (!cache.has(repo)) cache.set(repo, lookup(repo))
    return cache.get(repo) ?? 'unknown'
  }
}
