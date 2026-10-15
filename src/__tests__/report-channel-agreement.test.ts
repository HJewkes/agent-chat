import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { BUILTIN_PROFILES, parseProfile } from '../agents/profiles.js'
import { withReturnContract } from '../agents/return-contract.js'
import {
  IMPLEMENTER_WITHOUT_SHEPHERD,
  RETURN_CONTRACT_BLOCKS,
  REVIEWER_WITHOUT_SHEPHERD,
  SHEPHERD_NONE_MARKER,
} from '../agents/return-contract-blocks.js'
import { deniesChatSend, SPAWNED_RULES } from '../agents/standing-rules.js'
import { HUMAN } from '../protocol.js'
import { RETURN_CONTRACTS, type AgentProfile } from '../agents/types.js'

/**
 * CC-1354: a spawned agent must never be told both "report with chat_send" and "do not / need
 * not / cannot chat_send". The standing spawner rule yields to a channel its instructions name,
 * and drops out for a profile that denies chat_send.
 */

const PROFILES_DIR = path.join(__dirname, '../../profiles')

/** Copied verbatim from titan-platform packages/review-panel/src/reviewer-brief.ts (TP-738 a). */
const VERDICT_CHANNEL =
  'Write your verdict as text in your final message; Shepherd reads it from your session, so it needs no chat_send.'

const UNCONDITIONAL_RULE = 'Report progress, blockers and results to your spawner with chat_send.'

const NEGATION =
  /\b(no|not|never|without)\b[^.]{0,40}chat_send|chat_send[^.]{0,30}\b(not|never)\b|\bmessage peers\b/i

const shippedProfiles = (): AgentProfile[] =>
  fs
    .readdirSync(PROFILES_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const name = path.basename(file, '.json')
      const parsed = parseProfile(name, JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, file), 'utf8')))
      if ('error' in parsed) throw new Error(parsed.error)
      return parsed
    })

const ALL_PROFILES = [...BUILTIN_PROFILES, ...shippedProfiles()]

const launchText = (profile: AgentProfile, brief: string, spawner: string): string => {
  const contracted = withReturnContract({ brief, profile, spawner, resumed: false })
  const plan = buildLaunchPlan({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'worker',
    profile,
    brief: contracted.brief,
    cwd: '/repo',
    cwdHoldsUserSettings: false,
    adopted: false,
    surface: 'headless',
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
  })
  const systemPrompt = plan.args[plan.args.indexOf('--append-system-prompt') + 1] ?? ''
  return `${systemPrompt}\n\n${plan.stdin ?? ''}`
}

const chatSendSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.includes('chat_send'))

/** The chat_send instructions in a launch that clashes with a negation or denial, bar the conditional rule. */
const unconditionalInstructions = (profile: AgentProfile, text: string): string[] =>
  chatSendSentences(text).filter(
    sentence => !NEGATION.test(sentence) && (sentence !== SPAWNED_RULES || deniesChatSend(profile)),
  )

const clashes = (profile: AgentProfile, text: string): boolean =>
  deniesChatSend(profile) || NEGATION.test(text)

/** Each contract the profile can take, forced through its own field; a chat_send denier keeps its own only. */
type ContractOverride = NonNullable<AgentProfile['returnContract']> | 'own'

const contractOverrides = (profile: AgentProfile): ContractOverride[] =>
  deniesChatSend(profile) ? ['own', 'none'] : ['own', 'none', ...RETURN_CONTRACTS]

const withContract = (profile: AgentProfile, override: ContractOverride): AgentProfile =>
  override === 'own' ? profile : { ...profile, returnContract: override }

const BRIEFS: Record<string, { brief: string; spawner: string }> = {
  'peer-spawned': { brief: 'find every caller of foo()', spawner: 'coord' },
  'Shepherd: none': { brief: `find every caller of foo()\n\n${SHEPHERD_NONE_MARKER}`, spawner: 'coord' },
  'CLI-spawned': { brief: 'find every caller of foo()', spawner: HUMAN },
}

/** Shepherd spawns its reviewer over the CLI, so the verdict-channel brief never meets a contract block. */
const SHEPHERD_REVIEW_BRIEF = `Review PR #1.\n\n${VERDICT_CHANNEL}`

describe('no launch is told to chat_send beside a chat_send negation or denial (CC-1354)', () => {
  for (const base of ALL_PROFILES) {
    for (const override of contractOverrides(base)) {
      for (const [briefKind, { brief, spawner }] of Object.entries(BRIEFS)) {
        it(`${base.name}, contract ${String(override)}, ${briefKind} brief`, () => {
          const profile = withContract(base, override)
          const text = launchText(profile, brief, spawner)

          expect(text).not.toContain(UNCONDITIONAL_RULE)
          if (clashes(profile, text)) expect(unconditionalInstructions(profile, text)).toEqual([])
        })
      }
    }
  }

  it('every reviewer profile meets a Shepherd review brief without a clash', () => {
    for (const profile of ALL_PROFILES.filter(p => p.name.includes('reviewer'))) {
      expect(unconditionalInstructions(profile, launchText(profile, SHEPHERD_REVIEW_BRIEF, HUMAN))).toEqual(
        [],
      )
    }
  })

  it('a Shepherd review brief meets only the conditional report rule', () => {
    const reviewer = ALL_PROFILES.find(profile => profile.name === 'bd-reviewer')!

    const text = launchText(reviewer, SHEPHERD_REVIEW_BRIEF, HUMAN)

    expect(chatSendSentences(text).filter(sentence => !NEGATION.test(sentence))).toEqual([SPAWNED_RULES])
  })

  it('the triager, which denies chat_send, is never told to use it', () => {
    const triager = ALL_PROFILES.find(profile => profile.name === 'triager')!

    expect(deniesChatSend(triager)).toBe(true)
    expect(launchText(triager, 'triage the queue', 'coord')).not.toContain(SPAWNED_RULES)
  })

  it('agent-chat’s own preludes and contract blocks never negate chat_send', () => {
    const texts = [
      ...ALL_PROFILES.map(profile => profile.promptPrelude),
      ...Object.values(RETURN_CONTRACT_BLOCKS),
      IMPLEMENTER_WITHOUT_SHEPHERD,
      REVIEWER_WITHOUT_SHEPHERD,
    ]

    for (const text of texts)
      expect(chatSendSentences(text).filter(sentence => NEGATION.test(sentence))).toEqual([])
  })
})
