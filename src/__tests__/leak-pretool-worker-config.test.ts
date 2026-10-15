import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { roleOf } from '../agents/profiles.js'
import type { AgentProfile, LaunchPlanInput } from '../agents/types.js'
import { checkToolCall, guardContext, REASONS } from '../leak-guard/pretool.js'

const HOME = '/home/example'

const bdImplementer = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: 'bd-implementer',
  description: 'burndown implementer',
  model: 'opus',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
  isolation: 'worktree',
  surface: 'headless',
  promptPrelude: 'Implement the slice.',
  ...over,
})

const input = (profile: AgentProfile): LaunchPlanInput => ({
  agentId: 'ag000001',
  sessionId: '00000000-0000-4000-8000-000000000001',
  name: 'tc-x',
  profile,
  brief: 'implement a slice',
  cwd: '/repo',
  cwdHoldsUserSettings: false,
  adopted: false,
  mcpConfigPath: '/state/agents/ag000001/mcp.json',
})

const hookContext = (env: NodeJS.ProcessEnv) => guardContext({ PATH: '', ...env }, '/repo', HOME)

const CONFIG_WRITES: [string, Record<string, string>][] = [
  ['Bash', { command: 'echo {} > ~/.agent-chat/profiles/x.json' }],
  ['Bash', { command: 'cp a.json $HOME/.agent-chat/config.json' }],
  ['Write', { file_path: path.join(HOME, '.agent-chat/profiles/bd-implementer.json'), content: '{}' }],
]

describe('a worker writing agent-chat profiles or config (CC-1094)', () => {
  it('is denied for a bd-implementer, whose plan env names it a worker', () => {
    const ctx = hookContext(buildLaunchPlan(input(bdImplementer())).env)

    for (const [tool, call] of CONFIG_WRITES)
      expect(checkToolCall(tool, call, ctx)).toBe(REASONS.protectedPath)
  })

  it('is denied when the role is missing, so an older plan fails closed', () => {
    const ctx = hookContext({})

    for (const [tool, call] of CONFIG_WRITES)
      expect(checkToolCall(tool, call, ctx)).toBe(REASONS.protectedPath)
  })

  it('is left alone for a coordinator', () => {
    const ctx = hookContext({ AGENT_CHAT_ROLE: 'coordinator' })

    for (const [tool, call] of CONFIG_WRITES) expect(checkToolCall(tool, call, ctx)).toBeUndefined()
  })

  it('covers a relocated agent-chat home by its absolute path', () => {
    const ctx = hookContext({ AGENT_CHAT_ROLE: 'worker', AGENT_CHAT_HOME: '/srv/bus' })

    expect(checkToolCall('Bash', { command: 'rm /srv/bus/hooks.json' }, ctx)).toBe(REASONS.protectedPath)
    expect(checkToolCall('Edit', { file_path: '/srv/bus/profiles/peer.json' }, ctx)).toBe(
      REASONS.protectedPath,
    )
  })

  it('still lets a worker run an ordinary command', () => {
    const ctx = hookContext({ AGENT_CHAT_ROLE: 'worker' })

    expect(checkToolCall('Bash', { command: 'git status' }, ctx)).toBeUndefined()
    expect(checkToolCall('Write', { file_path: '/repo/profiles/peer.json' }, ctx)).toBeUndefined()
  })
})

const KEY_TOUCHES: [string, Record<string, string>][] = [
  ['Bash', { command: 'cat ~/.agent-chat/launcher.key' }],
  ['Bash', { command: 'cp ~/.agent-chat/launcher-keys/mac.key /tmp' }],
  ['Edit', { file_path: path.join(HOME, '.agent-chat/launcher.key'), old_string: 'a', new_string: 'b' }],
  [
    'Edit',
    { file_path: path.join(HOME, '.agent-chat/launcher-keys/mac.key'), old_string: 'a', new_string: 'b' },
  ],
]

describe('an agent touching the launcher key files (CC-1063)', () => {
  it.each([
    ['worker', { AGENT_CHAT_ROLE: 'worker' }],
    ['coordinator', { AGENT_CHAT_ROLE: 'coordinator' }],
    ['missing role', {}],
  ])('is denied for a %s', (_role, env) => {
    const ctx = hookContext(env)

    for (const [tool, call] of KEY_TOUCHES) expect(checkToolCall(tool, call, ctx)).toBe(REASONS.protectedPath)
  })

  it('covers a relocated agent-chat home by its absolute path, for a coordinator too', () => {
    const ctx = hookContext({ AGENT_CHAT_ROLE: 'coordinator', AGENT_CHAT_HOME: '/srv/bus' })

    expect(checkToolCall('Bash', { command: 'base64 /srv/bus/launcher.key' }, ctx)).toBe(
      REASONS.protectedPath,
    )
    expect(checkToolCall('Edit', { file_path: '/srv/bus/launcher-keys/mac.key' }, ctx)).toBe(
      REASONS.protectedPath,
    )
  })
})

describe('AGENT_CHAT_ROLE in the launch env', () => {
  it('is the profile role, and a profile cannot set it', () => {
    const worker = bdImplementer({ env: { AGENT_CHAT_ROLE: 'coordinator' } })
    const coordinator = bdImplementer({ role: 'coordinator' })

    expect(buildLaunchPlan(input(worker)).env.AGENT_CHAT_ROLE).toBe(roleOf(worker))
    expect(buildLaunchPlan(input(worker)).env.AGENT_CHAT_ROLE).toBe('worker')
    expect(buildLaunchPlan(input(coordinator)).env.AGENT_CHAT_ROLE).toBe('coordinator')
  })
})
