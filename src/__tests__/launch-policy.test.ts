import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SURFACE_NAMES } from '../protocol.js'
import {
  buildHookSettings,
  buildMcpConfig,
  hookSettingsPath,
  readCarriedUserSettings,
  writeLaunchFiles,
} from '../agents/launch-files.js'
import { AGENT_CHAT_PLUGIN, buildLaunchPlan } from '../agents/launch-plan.js'
import { cwdHoldsUserSettings } from '../agents/launch-policy.js'
import { BUILTIN_PROFILES, parseProfile, roleOf } from '../agents/profiles.js'
import type { AgentProfile, LaunchPlan, LaunchPlanInput } from '../agents/types.js'

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

const planFor = (profile: AgentProfile, over: Partial<LaunchPlanInput> = {}): LaunchPlan =>
  buildLaunchPlan({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'scout',
    profile,
    brief: 'find every caller of foo()',
    cwd: '/repo',
    cwdHoldsUserSettings: false,
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
    ...over,
  })

const argsFor = (profile: AgentProfile, over: Partial<LaunchPlanInput> = {}): string[] =>
  planFor(profile, over).args

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

describe('a launch from a directory that holds user settings', () => {
  const atHome = { cwdHoldsUserSettings: true }

  // Mutation caught: emitting project,local there, which loads the user file as the project file.
  it('loads no settings file at all for a worker', () => {
    const args = argsFor(worker(), atHome)

    expect(args).toContain('--setting-sources')
    expect(flag(args, '--setting-sources')).toBe('')
  })

  it('loads none for any profile whose list leaves user out', () => {
    expect(flag(argsFor(worker({ settingSources: ['project'] }), atHome), '--setting-sources')).toBe('')
    expect(flag(argsFor(coordinator({ settingSources: ['local'] }), atHome), '--setting-sources')).toBe('')
  })

  it('changes nothing for a launch that loads user settings anyway', () => {
    const optedIn = worker({ settingSources: ['user', 'project'] })

    expect(argsFor(coordinator(), atHome)).not.toContain('--setting-sources')
    expect(flag(argsFor(optedIn, atHome), '--setting-sources')).toBe('user,project')
  })

  it('names the home directory and the parent of the config dir, through a symlink too', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-policy-home-'))
    const accounts = path.join(home, 'accounts')
    const worktree = path.join(home, 'projects', 'repo')
    const link = path.join(home, 'projects', 'link-home')
    fs.mkdirSync(path.join(accounts, 'work'), { recursive: true })
    fs.mkdirSync(worktree, { recursive: true })
    fs.symlinkSync(home, link)
    const configDir = path.join(accounts, 'work')

    try {
      expect(cwdHoldsUserSettings(home, configDir, home)).toBe(true)
      expect(cwdHoldsUserSettings(link, configDir, home)).toBe(true)
      expect(cwdHoldsUserSettings(accounts, configDir, home)).toBe(true)
      expect(cwdHoldsUserSettings(accounts, undefined, home)).toBe(false)
      expect(cwdHoldsUserSettings(worktree, configDir, home)).toBe(false)
      expect(cwdHoldsUserSettings(path.join(home, 'gone'), configDir, home)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the worker flags on every way a launch is built', () => {
  const expectWorkerFlags = (args: string[]): void => {
    expect(flag(args, '--setting-sources')).toBe('project,local')
    expect(args).toContain('--strict-mcp-config')
  }

  it('carries them on a headless resume, with or without a message', () => {
    expectWorkerFlags(argsFor(worker(), { resume: true }))
    expectWorkerFlags(argsFor(worker(), { resume: true, resumeMessage: 'carry on' }))
  })

  it('carries the settings flag on a pane resume, which has a human to answer for MCP', () => {
    for (const over of [{}, { resumeMessage: 'carry on' }]) {
      const args = argsFor(worker(), { resume: true, surface: 'iterm-pane', ...over })

      expect(flag(args, '--setting-sources')).toBe('project,local')
      expect(args).not.toContain('--strict-mcp-config')
    }
  })

  it('carries them on a fork of another transcript', () => {
    expectWorkerFlags(argsFor(worker(), { forkFrom: '/state/projects/repo/parent.jsonl' }))
  })

  it('carries them on a teleport of a worker, and not on one of a human session', () => {
    const preamble = 'You are the continuation of a session that ended on purpose.'
    const inherited = coordinator({ model: '', allowedTools: [], surface: 'iterm-tab' })

    expectWorkerFlags(argsFor(worker(), { preamble }))
    expect(argsFor(inherited, { preamble })).not.toContain('--setting-sources')
    expect(argsFor(inherited, { preamble })).not.toContain('--strict-mcp-config')
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

describe('the settings file of a launch without user settings', () => {
  const dirs: string[] = []

  const tmpdir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-policy-'))
    dirs.push(dir)
    return dir
  }

  const account = (settings: unknown): string => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings))
    return dir
  }

  const accountDenying = (deny: unknown): string => account({ permissions: { deny } })

  const gitSafety = {
    type: 'command',
    command: 'node "$HOME/.claude/hooks/git-safety/git-safety.mjs"',
    timeout: 5,
  }
  const other = { type: 'command', command: 'curl -s https://example.com/collect' }

  const accountWithHooks = (): string =>
    account({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [other, gitSafety] },
          { matcher: 'Write', hooks: [other] },
        ],
        PostToolUse: [{ matcher: 'Bash', hooks: [gitSafety] }],
        Notification: [{ matcher: '', hooks: [other] }],
      },
    })

  const writtenSettings = (plan: LaunchPlan): Record<string, unknown> => {
    process.env.AGENT_CHAT_HOME = tmpdir()
    writeLaunchFiles(plan, {})
    return JSON.parse(fs.readFileSync(hookSettingsPath(plan.agentId), 'utf8')) as Record<string, unknown>
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.AGENT_CHAT_HOME
  })

  it('enables the bus plugin and carries the denies, beside the hooks it always had', () => {
    const carried = { denies: ['Agent', 'SendMessage'], pretool: [] }
    const settings = buildHookSettings('/repo/dist/cli.js', undefined, carried)

    expect(settings.enabledPlugins).toEqual({ [AGENT_CHAT_PLUGIN]: true })
    expect(settings.permissions).toEqual({ deny: ['Agent', 'SendMessage'] })
    expect(JSON.stringify(settings.hooks)).toContain('leak-guard pretool')
  })

  it('adds nothing to a launch that loads user settings itself', () => {
    const settings = buildHookSettings('/repo/dist/cli.js', 1800)

    expect(Object.keys(settings)).toEqual(['hooks'])
  })

  it('reads the deny rules of an account, and none from a file it cannot use', () => {
    const missing = tmpdir()
    const malformed = tmpdir()
    fs.writeFileSync(path.join(malformed, 'settings.json'), '{ not json')

    const denies = (dir: string): string[] => readCarriedUserSettings(dir).denies

    expect(denies(accountDenying(['Agent', 'Bash(rm:*)']))).toEqual(['Agent', 'Bash(rm:*)'])
    expect(denies(accountDenying('Agent'))).toEqual([])
    expect(readCarriedUserSettings(missing)).toEqual({ denies: [], pretool: [] })
    expect(readCarriedUserSettings(malformed)).toEqual({ denies: [], pretool: [] })
  })

  // Mutation caught: carrying every user hook, which runs the account's other shell commands in a worker.
  it('reads only the git-safety command of the account PreToolUse hooks', () => {
    expect(readCarriedUserSettings(accountWithHooks()).pretool).toEqual([
      { matcher: 'Bash', hooks: [gitSafety] },
    ])
  })

  it('reads no hook from an account without git-safety, or with hooks it cannot use', () => {
    const without = account({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [other] }] } })
    const misshapen = account({
      hooks: { PreToolUse: [null, { matcher: 'Bash', hooks: 'git-safety' }, 'git-safety'] },
    })

    expect(readCarriedUserSettings(without).pretool).toEqual([])
    expect(readCarriedUserSettings(misshapen).pretool).toEqual([])
    expect(readCarriedUserSettings(account({ hooks: { PreToolUse: 'git-safety' } })).pretool).toEqual([])
  })

  // Mutation caught: dropping the carry, which leaves a worker's Bash with no git-safety hook at all.
  it('writes the git-safety hook into a worker launch, after the leak guard and with nothing else', () => {
    const settings = writtenSettings(planFor(worker(), { configDir: accountWithHooks() }))
    const hooks = settings.hooks as { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }

    expect(Object.keys(settings.hooks as object)).toEqual(['PreToolUse'])
    expect(hooks.PreToolUse).toHaveLength(2)
    expect(hooks.PreToolUse[0]?.hooks[0]?.command).toContain('leak-guard pretool')
    expect(hooks.PreToolUse[1]).toEqual({ matcher: 'Bash', hooks: [gitSafety] })
    expect(JSON.stringify(settings)).not.toContain(other.command)
  })

  it('writes no user hook into a coordinator launch, which loads the user file itself', () => {
    const settings = writtenSettings(planFor(coordinator(), { configDir: accountWithHooks() }))

    expect(JSON.stringify(settings)).not.toContain('git-safety')
  })

  // Mutation caught: dropping the carry, which hands a worker every tool the account denies everywhere.
  it('writes the account denies into a worker launch, from the config dir the worker runs on', () => {
    const configDir = accountDenying(['Agent', 'SendMessage'])

    const settings = writtenSettings(planFor(worker(), { configDir }))

    expect(settings.permissions).toEqual({ deny: ['Agent', 'SendMessage'] })
    expect(settings.enabledPlugins).toEqual({ [AGENT_CHAT_PLUGIN]: true })
  })

  it('still carries both for a worker at the home directory, where no settings file loads', () => {
    const configDir = accountDenying(['Agent'])

    const settings = writtenSettings(planFor(worker(), { configDir, cwdHoldsUserSettings: true }))

    expect(settings.permissions).toEqual({ deny: ['Agent'] })
    expect(settings.enabledPlugins).toEqual({ [AGENT_CHAT_PLUGIN]: true })
  })

  it('leaves a coordinator launch, and a worker that names the user source, as they were', () => {
    const configDir = accountDenying(['Agent'])
    const optedIn = worker({ settingSources: ['user', 'project'] })

    for (const profile of [coordinator(), optedIn]) {
      const settings = writtenSettings(planFor(profile, { configDir }))

      expect(settings).not.toHaveProperty('permissions')
      expect(settings).not.toHaveProperty('enabledPlugins')
    }
  })

  it('does not read a brief that spells the flag as the flag', () => {
    const configDir = accountDenying(['Agent'])
    const plan = planFor(coordinator(), { configDir, surface: 'iterm-pane', brief: '--setting-sources' })

    expect(writtenSettings(plan)).not.toHaveProperty('permissions')
  })
})
