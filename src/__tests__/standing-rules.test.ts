import { describe, expect, it } from 'vitest'
import { buildLaunchPlan, HOOK_DENIAL_NOTE, PEER_PREAMBLE } from '../agents/launch-plan.js'
import {
  SESSION_RULES,
  SPAWNED_RULES,
  STANDING_RULES_MAX_CHARS,
  standingRulesFor,
} from '../agents/standing-rules.js'
import { TELEPORT_PREAMBLE } from '../agents/teleport.js'
import type { AgentProfile, LaunchPlanInput } from '../agents/types.js'

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: 'test',
  description: 'a profile',
  model: 'sonnet',
  allowedTools: ['Read'],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: 'Be brief.',
  ...over,
})

const input = (over: Partial<LaunchPlanInput> = {}): LaunchPlanInput => ({
  agentId: 'ag000001',
  sessionId: '00000000-0000-4000-8000-000000000001',
  name: 'scout',
  profile: profile(),
  brief: 'find every caller of foo()',
  cwd: '/repo',
  cwdHoldsUserSettings: false,
  adopted: false,
  mcpConfigPath: '/state/agents/ag000001/mcp.json',
  ...over,
})

const systemPromptOf = (over: Partial<LaunchPlanInput>): string => {
  const { args } = buildLaunchPlan(input(over))
  return args[args.indexOf('--append-system-prompt') + 1] ?? ''
}

describe('standing rules in every spawned agent’s system prompt (CC-281 a)', () => {
  const spawned: Record<string, Partial<LaunchPlanInput>> = {
    worker: {},
    coordinator: { profile: profile({ role: 'coordinator', surface: 'iterm-pane' }) },
    'hooked headless': { hookSettingsPath: '/state/agents/ag000001/settings.json' },
    'teleported spawned': { preamble: TELEPORT_PREAMBLE, surface: 'iterm-pane' },
  }

  for (const [kind, over] of Object.entries(spawned)) {
    it(`a ${kind} launch is told to report to its spawner, after its preamble`, () => {
      const prompt = systemPromptOf(over)

      expect(prompt.startsWith(over.preamble ?? PEER_PREAMBLE)).toBe(true)
      expect(prompt).toContain(standingRulesFor(false))
    })
  }

  it('a hooked launch puts them before the late-denial note and the profile prelude', () => {
    const prompt = systemPromptOf(spawned['hooked headless']!)

    expect(prompt.indexOf(SESSION_RULES)).toBeLessThan(prompt.indexOf(HOOK_DENIAL_NOTE))
    expect(prompt.indexOf(HOOK_DENIAL_NOTE)).toBeLessThan(prompt.indexOf('Be brief.'))
  })

  it('a teleported adopted session, a human’s own pane, gets the session rules and no spawner', () => {
    const prompt = systemPromptOf({ preamble: TELEPORT_PREAMBLE, surface: 'iterm-pane', adopted: true })

    expect(prompt).toContain(SESSION_RULES)
    expect(prompt).not.toContain(SPAWNED_RULES)
    expect(prompt).not.toMatch(/spawner/)
  })

  it('stay within their per-spawn budget and name the report channel and the own-call rule', () => {
    expect(standingRulesFor(false).length).toBeLessThanOrEqual(STANDING_RULES_MAX_CHARS)
    expect(SPAWNED_RULES).toContain('chat_send')
    expect(SESSION_RULES).toContain('autoMode.allow')
    expect(SESSION_RULES).toMatch(/merge, a remote branch delete, a deploy or a tag push as its own/)
  })
})
