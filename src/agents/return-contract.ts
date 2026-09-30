import { HUMAN } from '../protocol.js'
import { roleOf } from './profiles.js'
import { RETURN_CONTRACT_BLOCKS } from './return-contract-blocks.js'
import { RETURN_CONTRACTS, type AgentProfile, type ReturnContract } from './types.js'

/**
 * CC-286: the return contract a spawned agent's brief ends with.
 *
 * Coordinators pasted these rules into every brief by hand, so the copies drifted
 * and each one was paid for on every coordinator turn. The text now lives in one
 * module and the broker appends the block that fits the profile.
 */

const PLACEHOLDER = '<spawner>'

const LAST_ACTION = /\blast action\b/i
const STATUS_LINE = /\bStatus:\s*DONE\s*\|\s*DONE_WITH_CONCERNS\s*\|\s*BLOCKED\s*\|\s*NEEDS_CONTEXT\b/
const VERDICT_LINE = /\bVerdict:\s*MERGE\s*(?:\(\s*or\s+FIX_FIRST\s*\)|or\s+FIX_FIRST\b|\|\s*FIX_FIRST\b)/
const PR_LINE = /\bPR:\s*\S/
const HEAD_LINE = /\bHead:\s*\S/

/** Every line the spawner's tooling parses: a brief that quotes only some of them still needs the block. */
const CARRIED: Record<ReturnContract, readonly RegExp[]> = {
  implementer: [LAST_ACTION, STATUS_LINE, PR_LINE, HEAD_LINE],
  reviewer: [VERDICT_LINE, PR_LINE, HEAD_LINE],
}

/** A report line of the brief's own, at a line start or quoted inline. */
const OWN_REPORT_LINE = /(?:^|[\s`*])(?:Status|Verdict):/

const mayEdit = (profile: AgentProfile): boolean =>
  profile.allowedTools.includes('Edit') && !(profile.disallowedTools ?? []).includes('Edit')

/** A name says so only as a whole word, so `preimplementer` and a name carrying both words say nothing. */
function namedContract(name: string): ReturnContract | undefined {
  const words = name.split(/[-_]/)
  const named = RETURN_CONTRACTS.filter(contract => words.includes(contract))
  return named.length === 1 ? named[0] : undefined
}

/**
 * Which block a profile takes. The field wins; a profile file that predates it
 * is read by name, and only when its role and grants agree, because a wrong
 * block misleads an agent and a missing one costs the spawner a sentence.
 */
export function contractOf(profile: AgentProfile): ReturnContract | undefined {
  if (profile.returnContract !== undefined)
    return profile.returnContract === 'none' ? undefined : profile.returnContract
  if (roleOf(profile) !== 'worker') return undefined
  const named = namedContract(profile.name)
  if (named === undefined) return undefined
  return (named === 'implementer') === mayEdit(profile) ? named : undefined
}

/** Whether a brief already carries a pasted copy of this block, in any wording or wrapping. */
export const carriesContract = (brief: string, contract: ReturnContract): boolean =>
  CARRIED[contract].every(line => line.test(brief))

export interface ContractInput {
  brief: string
  profile: AgentProfile
  /** The requester's registered name, or `HUMAN` for a CLI spawn. */
  spawner: string
  /** A resumed conversation was handed its contract when it was first spawned. */
  resumed: boolean
  /** The spawn's own `return_contract`: `none` when the brief states its own report format. */
  requested?: 'none'
}

export interface Contracted {
  brief: string
  warnings: string[]
}

/** A CLI spawn has no registered name to report to, and `burndown tick` spawns that way with its own format. */
function contractFor(input: ContractInput): ReturnContract | undefined {
  if (input.resumed || input.requested === 'none' || input.spawner === HUMAN) return undefined
  return contractOf(input.profile)
}

const pastedWarning = (contract: ReturnContract): string =>
  `the brief already carries the ${contract} return contract; the broker appends it, so stop pasting it`

const ownFormatWarning = (contract: ReturnContract): string =>
  `the brief has a Status: or Verdict: line of its own and the ${contract} return contract was appended ` +
  'after it; pass return_contract: "none" if your format should stand alone'

/** The brief as the agent receives it. */
export function withReturnContract(input: ContractInput): Contracted {
  const { brief, spawner } = input
  const contract = contractFor(input)
  if (contract === undefined) return { brief, warnings: [] }
  if (carriesContract(brief, contract)) return { brief, warnings: [pastedWarning(contract)] }
  // A function, so `$&` in a spawner name is text and not a replacement pattern.
  const block = RETURN_CONTRACT_BLOCKS[contract].replaceAll(PLACEHOLDER, () => spawner)
  const warnings = OWN_REPORT_LINE.test(brief) ? [ownFormatWarning(contract)] : []
  return { brief: `${brief}\n\n${block}`, warnings }
}
