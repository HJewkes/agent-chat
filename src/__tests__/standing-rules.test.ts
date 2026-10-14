import { describe, expect, it } from 'vitest'
import { buildLaunchPlan, HOOK_DENIAL_NOTE, PEER_PREAMBLE } from '../agents/launch-plan.js'
import { STANDING_RULES, STANDING_RULES_MAX_CHARS } from '../agents/standing-rules.js'
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
  mcpConfigPath: '/state/agents/ag000001/mcp.json',
  ...over,
})

const systemPromptOf = (over: Partial<LaunchPlanInput>): string => {
  const { args } = buildLaunchPlan(input(over))
  return args[args.indexOf('--append-system-prompt') + 1] ?? ''
}

describe('standing rules in every spawned agent’s system prompt (CC-281 a)', () => {
  const launches: Record<string, Partial<LaunchPlanInput>> = {
    worker: {},
    coordinator: { profile: profile({ role: 'coordinator', surface: 'iterm-pane' }) },
    'hooked headless': { hookSettingsPath: '/state/agents/ag000001/settings.json' },
  }

  for (const [kind, over] of Object.entries(launches)) {
    it(`a ${kind} launch carries them after the peer preamble`, () => {
      const prompt = systemPromptOf(over)

      expect(prompt.indexOf(PEER_PREAMBLE)).toBe(0)
      expect(prompt.indexOf(STANDING_RULES)).toBeGreaterThan(0)
    })
  }

  it('a hooked launch puts them before the late-denial note and the profile prelude', () => {
    const prompt = systemPromptOf(launches['hooked headless']!)

    expect(prompt.indexOf(STANDING_RULES)).toBeLessThan(prompt.indexOf(HOOK_DENIAL_NOTE))
    expect(prompt.indexOf(HOOK_DENIAL_NOTE)).toBeLessThan(prompt.indexOf('Be brief.'))
  })

  it('a teleported descendant keeps them under its own preamble', () => {
    const prompt = systemPromptOf({ preamble: TELEPORT_PREAMBLE })

    expect(prompt.startsWith(TELEPORT_PREAMBLE)).toBe(true)
    expect(prompt).toContain(STANDING_RULES)
  })

  it('stay within their per-spawn budget and name the report channel and the own-call rule', () => {
    expect(STANDING_RULES.length).toBeLessThanOrEqual(STANDING_RULES_MAX_CHARS)
    expect(STANDING_RULES).toContain('chat_send')
    expect(STANDING_RULES).toContain('autoMode.allow')
    expect(STANDING_RULES).toMatch(/merge, a remote branch delete, a deploy or a tag push as its own/)
  })
})
