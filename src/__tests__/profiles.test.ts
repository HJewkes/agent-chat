import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { loadProfile } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'

const REPO_PROFILES = path.join(__dirname, '../../profiles')

function triager(): AgentProfile {
  const profile = loadProfile('triager', REPO_PROFILES)
  if ('error' in profile) throw new Error(profile.error)
  return profile
}

describe('the triager profile (CC-650)', () => {
  it('loads from the repo profiles directory as a headless, read-only job', () => {
    const profile = triager()

    expect(profile).toMatchObject({ model: 'fable', surface: 'headless', isolation: 'none' })
    expect(profile.surfaceLifetime).toBe('close-on-exit')
  })

  // Mutation caught: dropping a write verb, which leaves the triager unable to release or file a follow-up.
  it('allows the three write verbs and the log read', () => {
    expect(triager().allowedTools).toEqual(
      expect.arrayContaining([
        'Bash(agent-chat burndown release:*)',
        'Bash(active-work task add:*)',
        'Bash(active-work task edit:*)',
        'Bash(agent-chat agent logs:*)',
      ]),
    )
  })

  it('denies editing code and pushing', () => {
    expect(triager().disallowedTools).toEqual(
      expect.arrayContaining(['Edit', 'NotebookEdit', 'Bash(git push:*)']),
    )
  })

  // Mutation caught: splitting the blanket `agent-chat agent:*` deny and losing the spawn deny.
  it('denies every agent verb that acts, by name, and not the blanket that would hide logs', () => {
    const denied = triager().disallowedTools ?? []

    for (const verb of ['spawn', 'resume', 'retire', 'background', 'surface', 'teleport'])
      expect(denied).toContain(`Bash(agent-chat agent ${verb}:*)`)
    expect(denied).toContain('Bash(agent-chat port:*)')
    expect(denied).not.toContain('Bash(agent-chat agent:*)')
  })

  // Mutation caught: leaving Write unnamed, which falls through to the inherited user settings.
  it('denies Write and does not allow it', () => {
    expect(triager().disallowedTools).toContain('Write')
    expect(triager().allowedTools).not.toContain('Write')
  })

  // Mutation caught: a deny that swallows `agent logs`, which the triager reads its transcript through.
  it('has no deny that matches `agent-chat agent logs`', () => {
    const probe = 'agent-chat agent logs'
    const matches = (rule: string): boolean => {
      const m = /^Bash\((.*):\*\)$/.exec(rule)
      return m?.[1] !== undefined && probe.startsWith(m[1])
    }

    expect((triager().disallowedTools ?? []).filter(matches)).toEqual([])
  })
})

function beatBuilderTsx(): AgentProfile {
  const profile = loadProfile('beat-builder-tsx', REPO_PROFILES)
  if ('error' in profile) throw new Error(profile.error)
  return profile
}

describe('the beat-builder-tsx profile (TP-2608)', () => {
  it('loads as a headless sonnet worker in the cwd it is given, with no warnings', () => {
    const profile = beatBuilderTsx()

    expect(profile).toMatchObject({ model: 'sonnet', surface: 'headless', isolation: 'none' })
    expect(profile.warnings).toBeUndefined()
  })

  // Mutation caught: granting Bash or a search tool, which lets the worker build, fetch or roam.
  it('allows Read, Write and Edit inside its cwd and nothing else', () => {
    expect(beatBuilderTsx().allowedTools).toEqual(['Read(./**)', 'Write(./**)', 'Edit(./**)'])
  })

  // Mutation caught: a bare grant, which a headless call outside the scratch cwd matches instead of being refused.
  it('grants no file tool without a path scope', () => {
    for (const tool of ['Read', 'Write', 'Edit']) expect(beatBuilderTsx().allowedTools).not.toContain(tool)
  })

  it('still launches with exactly Read, Write and Edit as its tool set', () => {
    const { args } = buildLaunchPlan({
      agentId: 'ag000001',
      sessionId: '00000000-0000-4000-8000-000000000001',
      name: 'layer-repair',
      profile: beatBuilderTsx(),
      brief: 'repair the module',
      cwd: '/scratch',
      cwdHoldsUserSettings: false,
      adopted: false,
      mcpConfigPath: '/state/agents/ag000001/mcp.json',
    })

    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Write,Edit')
  })

  // Mutation caught: dropping ToolSearch from the denies, which reaches every deferred MCP tool.
  it('denies the shell, the web, MCP discovery and the human-authority verbs', () => {
    expect(beatBuilderTsx().disallowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'WebSearch',
        'WebFetch',
        'ToolSearch',
        'AskUserQuestion',
        'Bash(agent-chat send:*)',
        'Bash(agent-chat endorse:*)',
        'Bash(agent-chat approve:*)',
        'Bash(agent-chat agent:*)',
        'mcp__plugin_agent-chat_agent-chat__chat_send',
        'mcp__plugin_agent-chat_agent-chat__agent_spawn',
      ]),
    )
  })

  it('pins the gate contract in its prelude', () => {
    const prelude = beatBuilderTsx().promptPrelude

    for (const rule of ['`react`', '`@titan-design/react-ui/motion`', 'Math.random', 'DATA', 'stop.'])
      expect(prelude).toContain(rule)
  })
})
