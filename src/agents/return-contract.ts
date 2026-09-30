import fs from 'node:fs'
import { returnContractPath } from '../paths.js'
import { HUMAN } from '../protocol.js'
import { roleOf } from './profiles.js'
import { RETURN_CONTRACTS, type AgentProfile, type ReturnContract } from './types.js'

/**
 * CC-286: the return contract a spawned agent's brief ends with.
 *
 * Coordinators pasted these rules into every brief by hand, so the copies drifted
 * and each one was paid for on every coordinator turn. The text now lives in one
 * file and the broker appends the block that fits the profile.
 */

const PLACEHOLDER = '<spawner>'

/** The phrases every pasted copy of a block carries, however the rest was reworded or rewrapped. */
const SIGNATURES: Record<ReturnContract, readonly string[]> = {
  implementer: ['LAST action must be chat_send to', 'Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT'],
  reviewer: ['Verdict: MERGE (or FIX_FIRST)'],
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ')

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

/** Whether a brief already carries a pasted copy of this block, in any wording. */
export function carriesContract(brief: string, contract: ReturnContract): boolean {
  const flat = collapse(brief)
  return SIGNATURES[contract].every(phrase => flat.includes(phrase))
}

/** The fenced text under `## <contract>`, or nothing when the file or the section is missing. */
export function readContract(
  contract: ReturnContract,
  file: string = returnContractPath(),
): string | undefined {
  if (!fs.existsSync(file)) return undefined
  const section = new RegExp(`^## ${contract}\\n+\`\`\`\\n([\\s\\S]*?)\\n\`\`\`$`, 'm')
  return section.exec(fs.readFileSync(file, 'utf8'))?.[1]
}

export interface ContractInput {
  brief: string
  profile: AgentProfile
  /** The requester's registered name, or `HUMAN` for a CLI spawn. */
  spawner: string
  /** A resumed conversation was handed its contract when it was first spawned. */
  resumed: boolean
  file?: string
}

export interface Contracted {
  brief: string
  warnings: string[]
}

/**
 * The brief as the agent receives it. A CLI spawn has no registered name to
 * report to, and `burndown tick` spawns that way with a report format of its own.
 */
export function withReturnContract(input: ContractInput): Contracted {
  const { brief, spawner } = input
  const contract = input.resumed || spawner === HUMAN ? undefined : contractOf(input.profile)
  if (contract === undefined) return { brief, warnings: [] }
  if (carriesContract(brief, contract))
    return {
      brief,
      warnings: [
        `the brief already carries the ${contract} return contract; the broker appends it, so stop pasting it`,
      ],
    }
  const block = readContract(contract, input.file)
  if (block === undefined)
    return {
      brief,
      warnings: [
        `no ${contract} return contract in ${input.file ?? returnContractPath()}; spawned without it`,
      ],
    }
  return { brief: `${brief}\n\n${block.replaceAll(PLACEHOLDER, spawner)}`, warnings: [] }
}
