import { describe, expect, it } from 'vitest'
import { SURFACE_NAMES } from '../protocol.js'
import { buildMcpConfig } from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { BUILTIN_PROFILES, parseProfile, roleOf } from '../agents/profiles.js'
import type { AgentProfile, LaunchPlanInput } from '../agents/types.js'

const worker = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: 'worker',
  description: 'a worker profile',
  model: 'sonnet',
  allowedTools: ['Read', 'Grep'],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: '',
  ...over,
})

const coordinator = (over: Partial<AgentProfile> = {}): AgentProfile =>
  worker({ name: 'coordinator', role: 'coordinator', ...over })

const argsFor = (profile: AgentProfile, over: Partial<LaunchPlanInput> = {}): string[] =>
  buildLaunchPlan({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'scout',
    profile,
    brief: 'find every caller of foo()',
    cwd: '/repo',
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
    ...over,
  }).args

const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const serversFor = (profile: AgentProfile, surface?: AgentProfile['surface']): string[] =>
  Object.keys(buildMcpConfig(profile, '/repo/dist/cli.js', surface).mcpServers as Record<string, unknown>)

describe('the settings a launch loads', () => {
  // Mutation caught: dropping the flag, which lets the account's user-level allow rules approve unlisted tools.
  it.each(SURFACE_NAMES)('keeps user settings out of a worker launch on %s', surface => {
    expect(flag(argsFor(worker(), { surface }), '--setting-sources')).toBe('project,local')
  })

  it.each(SURFACE_NAMES)('leaves a coordinator launch on %s with every source', surface => {
    expect(argsFor(coordinator(), { surface })).not.toContain('--setting-sources')
  })

  it('leaves a teleported human session, which names no tools, with every source', () => {
    const inherited = coordinator({ model: '', allowedTools: [], surface: 'iterm-tab' })

    expect(argsFor(inherited)).not.toContain('--setting-sources')
    expect(argsFor(inherited)).not.toContain('--strict-mcp-config')
  })

  it('keeps user settings out of every builtin, since none of them is a coordinator', () => {
    for (const builtin of BUILTIN_PROFILES) {
      expect(roleOf(builtin)).toBe('worker')
      expect(flag(argsFor(builtin), '--setting-sources')).toBe('project,local')
    }
  })

  it('emits the sources a profile names, for either role', () => {
    const widened = worker({ settingSources: ['user', 'project', 'local'] })
    const narrowed = coordinator({ settingSources: ['project'] })

    expect(flag(argsFor(widened), '--setting-sources')).toBe('user,project,local')
    expect(flag(argsFor(narrowed), '--setting-sources')).toBe('project')
  })

  it('emits an empty value for a profile that names no source, rather than no flag', () => {
    const args = argsFor(worker({ settingSources: [] }))

    expect(args).toContain('--setting-sources')
    expect(flag(args, '--setting-sources')).toBe('')
  })

  it('reads settingSources from a profile file and refuses a source that does not exist', () => {
    const base = { model: 'opus', allowedTools: ['Read'], isolation: 'none', surface: 'headless' }

    expect(parseProfile('ok', { ...base, settingSources: ['project'] })).toMatchObject({
      settingSources: ['project'],
    })
    expect(parseProfile('ok', { ...base, settingSources: ['project'] })).not.toHaveProperty('warnings')
    expect(parseProfile('bad', { ...base, settingSources: ['global'] })).toHaveProperty('error')
    expect(parseProfile('bad', { ...base, settingSources: 'project' })).toHaveProperty('error')
  })
})

describe('the MCP servers a launch loads', () => {
  // Mutation caught: keying strict mode on the profile flag alone, which leaves every unflagged worker on the account's servers.
  it('gives a headless worker only its generated MCP config', () => {
    const args = argsFor(worker())

    expect(args.indexOf('--strict-mcp-config')).toBe(args.indexOf('--mcp-config') + 2)
  })

  it('names agent-chat and the servers the profile lists, and nothing else', () => {
    const profile = worker({ mcpServers: { 'active-work': { type: 'http', url: 'http://127.0.0.1:1/mcp' } } })

    expect(serversFor(worker())).toEqual(['plugin:agent-chat:agent-chat'])
    expect(serversFor(profile)).toEqual(['plugin:agent-chat:agent-chat', 'active-work'])
  })

  it('follows the surface the launch runs on, not the one the profile declares', () => {
    const pane = worker({ surface: 'iterm-pane' })

    expect(argsFor(pane, { surface: 'headless' })).toContain('--strict-mcp-config')
    expect(serversFor(pane, 'headless')).toEqual(['plugin:agent-chat:agent-chat'])
    expect(argsFor(worker(), { surface: 'iterm-pane' })).not.toContain('--strict-mcp-config')
    expect(serversFor(worker(), 'iterm-pane')).toEqual([])
  })

  it.each(SURFACE_NAMES)('leaves a coordinator launch on %s with the servers it had', surface => {
    expect(argsFor(coordinator(), { surface })).not.toContain('--strict-mcp-config')
    expect(serversFor(coordinator(), surface)).toEqual([])
  })

  it('lets a profile opt a headless worker out, and a coordinator in', () => {
    const optedOut = worker({ strictMcpConfig: false })
    const optedIn = coordinator({ strictMcpConfig: true })

    expect(argsFor(optedOut)).not.toContain('--strict-mcp-config')
    expect(serversFor(optedOut)).toEqual([])
    expect(argsFor(optedIn)).toContain('--strict-mcp-config')
    expect(serversFor(optedIn)).toEqual(['plugin:agent-chat:agent-chat'])
  })
})
