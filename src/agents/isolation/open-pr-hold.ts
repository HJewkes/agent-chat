import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { allocatedWorktree, type ParkTarget } from './park.js'
import type { ShepherdSkipPort } from './shepherd-skip.js'

/**
 * CC-1325: the bulk finished retire keeps an implementer or reviewer while a PR it worked on is open,
 * Shepherd-registered or not. Shepherd resumes a non-retired implementer warm and starts a cold
 * successor for a retired one, and a seat re-asks a reviewer by name. Overrides CC-950 for the bulk path only.
 */

export interface HeldBranch {
  gitRoot: string
  branch: string
}

export type OpenPrRead = ShepherdSkipPort['hasOpenPr']

/** `<base>-review`, `<base>-review-rN` (seat re-asks) and `<base>-rN` (burndown's reviewer). */
const REVIEWER_NAME = /^(.+?)-(?:review(?:-r\d+)?|r\d+)$/

export function reviewedAgentName(name: string): string | undefined {
  return REVIEWER_NAME.exec(name)?.[1]
}

/** Every branch whose open PR holds `agent`; a branch with no repo to ask is dropped. */
export function heldBranches(
  agent: AgentIdentity,
  target: ParkTarget | undefined,
  roster: readonly AgentIdentity[],
  events: readonly AgentEventRow[],
): HeldBranch[] {
  const base = reviewedAgentName(agent.name)
  const baseTargets = base === undefined ? [] : baseRowTargets(base, roster, events)
  const gitRoot = target?.gitRoot ?? baseTargets[0]?.gitRoot
  const named = [`agent-chat/${agent.name}`, ...(target ? [target.branch] : [])]
  if (base !== undefined) named.push(`agent-chat/${base}`)
  const candidates = [
    ...(gitRoot === undefined ? [] : named.map(branch => ({ gitRoot, branch }))),
    ...baseTargets.map(t => ({ gitRoot: t.gitRoot, branch: t.branch })),
  ]
  return [...new Map(candidates.map(c => [`${c.gitRoot}\0${c.branch}`, c])).values()]
}

function baseRowTargets(
  base: string,
  roster: readonly AgentIdentity[],
  events: readonly AgentEventRow[],
): ParkTarget[] {
  return roster
    .filter(a => a.name === base)
    .map(a => allocatedWorktree(events, a.agentId))
    .filter((t): t is ParkTarget => t !== undefined)
}

/** One `gh` read per repo and branch for a whole plan; a failed read is remembered as failed. */
export function memoizeOpenPr(read: OpenPrRead): OpenPrRead {
  const answers = new Map<string, Promise<boolean>>()
  return (gitRoot, branch) => {
    const key = `${gitRoot}\0${branch}`
    let answer = answers.get(key)
    if (answer === undefined) {
      answer = read(gitRoot, branch)
      answers.set(key, answer)
    }
    return answer
  }
}

const firstLine = (err: unknown): string => String((err as Error).message ?? err).split('\n')[0] ?? ''

/** Why an open PR holds the agent, or undefined when none does. A read that fails is a skip. */
export async function openPrHold(
  hasOpenPr: OpenPrRead,
  candidates: readonly HeldBranch[],
): Promise<string | undefined> {
  for (const { gitRoot, branch } of candidates) {
    try {
      if (await hasOpenPr(gitRoot, branch)) return `open PR on ${branch} (kept until merged or closed)`
    } catch (err) {
      return `could not tell whether ${branch} has an open PR (${firstLine(err)})`
    }
  }
  return undefined
}
