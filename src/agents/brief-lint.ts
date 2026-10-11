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

/** Only quiets a mention's warning; a refusal never depends on it. */
const NEGATION = /\b(?:never|not|cannot|dont|no|without|avoid|instead|rather)\b|n't\b/i

const SYNTHETIC_LINE = /synthetic/i

/** The plan's scope: only agent-chat verbs, since a git or gh deny is named in task text far more than it is asked for. */
const AGENT_CHAT_DENY = /^Bash\((agent-chat [\w-]+):\*\)$/

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

interface Unusable {
  term: string
  why: string
}

/**
 * How a brief names a term. `directive` is a clause that opens with an
 * imperative ("use X", "then run X"); `mention` is any other un-negated naming,
 * which is only warned on. The directive shape is an allowlist on purpose:
 * prohibitions and contrasts ("you cannot use X", "rather than use X", "you
 * mustn't call X") have too many phrasings to list, and none of them opens a
 * clause with the verb, so every phrasing not listed here falls to a warning
 * and a false refusal cannot block a spawn.
 */
type Ask = 'directive' | 'mention' | undefined

const clausesOf = (brief: string): string[] => brief.split(/[.!?;:,\n]+/)

/** Words that may precede the imperative without changing what it asks. */
const LEAD_IN = String.raw`(?:(?:then|and|please|now|first|next|also|finally|so)\s+)*`

/** A list marker or emphasis a clause may open with. */
const MARKER = String.raw`(?:[-*+>]|\d+[.)])?\s*`

function askOf(brief: string, term: string): Ask {
  const name = `${escape(term)}(?![\\w-])`
  const mention = new RegExp(`(?<![\\w-])${name}`)
  const directive = new RegExp(`^\\s*${MARKER}${LEAD_IN}(?:use|run|call|invoke)\\s+[\`'"]?${name}`, 'i')
  if (clausesOf(brief).some(clause => directive.test(clause))) return 'directive'
  const named = sentencesOf(brief).some(sentence => mention.test(sentence) && !NEGATION.test(sentence))
  return named ? 'mention' : undefined
}

/** The literal a deny entry blocks: a CamelCase tool name, or the verb inside `Bash(agent-chat <verb>:*)`. */
function deniedTerm(entry: string): string | undefined {
  const command = AGENT_CHAT_DENY.exec(entry)?.[1]
  if (command !== undefined) return command
  return CAMEL_CASE_TOOL.test(entry) ? entry : undefined
}

function unusableTerms({ profile, surface }: BriefLintInput): Unusable[] {
  const denied = (profile.disallowedTools ?? []).flatMap(entry => {
    const term = deniedTerm(entry)
    return term === undefined ? [] : [{ term, why: `which the profile denies (${entry})` }]
  })
  const headless =
    surface === 'headless'
      ? HEADLESS_UNUSABLE.map(term => ({ term, why: 'which a headless agent cannot use' }))
      : []
  return [...denied, ...headless]
}

export function lintBrief(input: BriefLintInput): BriefLint {
  const { brief, profile } = input
  const warnings: string[] = []
  let refusal: string | undefined
  for (const { term, why } of unusableTerms(input)) {
    const ask = askOf(brief, term)
    if (ask === 'directive') refusal ??= `brief asks ${profile.name} to use ${term}, ${why}; reword the brief`
    if (ask === 'mention')
      warnings.push(`brief names ${term}, ${why}; check ${profile.name} is not expected to use it`)
  }
  if (input.repoVisibility === 'public' && !mentionsSyntheticData(brief))
    warnings.push(
      'brief targets a public repo but has no synthetic-data line; real data could land in the PR',
    )
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
 * for the broker's life. Any failure is `unknown`, which warns about nothing and
 * is not cached, so one timeout does not silence the warning until a restart.
 */
export function repoVisibilityReader(
  git: GitRunner = runGit,
  gh: GhRunner = runGh,
): (cwd: string) => Promise<RepoVisibility> {
  const cache = new Map<string, RepoVisibility>()
  const lookup = async (repo: string): Promise<RepoVisibility> => {
    const known = cache.get(repo)
    if (known !== undefined) return known
    const read = await gh(['api', `repos/${repo}`, '--jq', '.visibility']).then(
      asVisibility,
      () => 'unknown' as const,
    )
    if (read !== 'unknown') cache.set(repo, read)
    return read
  }
  return async cwd => {
    const url = await git(['config', '--get', 'remote.origin.url'], cwd).catch(() => null)
    const repo = url === null ? undefined : githubRepoOf(url)
    return repo === undefined ? 'unknown' : lookup(repo)
  }
}
