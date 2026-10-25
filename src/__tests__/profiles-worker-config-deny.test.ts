import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { BUILTIN_PROFILES, loadProfile, roleOf, workerConfigDenies } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'

let agentHome: string
let dir: string

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc1094-'))
  dir = path.join(agentHome, 'profiles')
  fs.mkdirSync(dir)
})

afterEach(() => fs.rmSync(agentHome, { recursive: true, force: true }))

const bdImplementer = {
  model: 'opus',
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Write(//**)'],
  disallowedTools: [
    'Bash(agent-chat send:*)',
    'Bash(agent-chat teleport:*)',
    'Bash(agent-chat debug send:*)',
    'Bash(agent-chat burndown:*)',
    'Bash(agent-chat seats:*)',
  ],
  isolation: 'worktree',
  surface: 'headless',
}

function load(name: string, body?: Record<string, unknown>): AgentProfile {
  if (body !== undefined) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body))
  const profile = loadProfile(name, dir)
  if ('error' in profile) throw new Error(profile.error)
  return profile
}

const deniedAtLaunch = (profile: AgentProfile): string[] => {
  const { args } = buildLaunchPlan({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'worker',
    profile,
    brief: 'implement the slice',
    cwd: '/repo',
    cwdHoldsUserSettings: false,
    adopted: false,
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
  })
  return (args[args.indexOf('--disallowed-tools') + 1] ?? '').split(',')
}

describe('a worker profile cannot edit agent-chat profiles or config (CC-1094)', () => {
  it('denies Write, Edit and MultiEdit on the profiles dir and the config json of its own home', () => {
    const profile = load('bd-implementer', bdImplementer)

    expect(profile.disallowedTools).toEqual(expect.arrayContaining(workerConfigDenies(agentHome)))
    expect(profile.disallowedTools).toContain(`Write(/${agentHome}/profiles/**)`)
    expect(profile.disallowedTools).toContain(`Edit(/${agentHome}/*.json)`)
    expect(profile.disallowedTools).toContain(`MultiEdit(/${agentHome}/profiles/**)`)
    expect(profile.warnings).toBeUndefined()
  })

  it('reaches Claude Code on the launch command line', () => {
    const denied = deniedAtLaunch(load('bd-implementer', bdImplementer))

    expect(denied).toEqual(expect.arrayContaining(workerConfigDenies(agentHome)))
  })

  // Mutation caught: testing `role === 'worker'`, which lets a profile with no role skip the deny.
  it('treats a profile with no role as a worker', () => {
    expect(roleOf(load('bd-implementer', bdImplementer))).toBe('worker')
    expect(load('bd-implementer').disallowedTools).toContain(`Edit(/${agentHome}/profiles/**)`)
  })

  it('gives a coordinator profile none of the rules', () => {
    const profile = load('example-coord', { ...bdImplementer, role: 'coordinator' })

    expect(profile.disallowedTools).toEqual(bdImplementer.disallowedTools)
    expect(profile.warnings).toBeUndefined()
  })

  it('keeps the rules when allowedTools names them', () => {
    const allowedTools = [...bdImplementer.allowedTools, ...workerConfigDenies(agentHome)]

    const profile = load('bd-implementer', { ...bdImplementer, allowedTools })

    expect(profile.disallowedTools).toEqual(expect.arrayContaining(workerConfigDenies(agentHome)))
  })

  it('adds no duplicate when the file already lists the rules', () => {
    const disallowedTools = [...bdImplementer.disallowedTools, ...workerConfigDenies(agentHome)]

    const profile = load('bd-implementer', { ...bdImplementer, disallowedTools })

    expect(profile.disallowedTools).toEqual(disallowedTools)
    expect(profile.warnings).toBeUndefined()
  })

  // Mutation caught: returning a builtin unchanged, the path every builtin worker took before.
  it.each(BUILTIN_PROFILES.filter(p => roleOf(p) === 'worker').map(p => [p.name]))(
    'gives the %s builtin the rules, keyed to the profiles dir parent',
    name => {
      const profile = load(name)

      expect(profile.disallowedTools).toEqual(expect.arrayContaining(workerConfigDenies(agentHome)))
      expect(profile.warnings).toBeUndefined()
    },
  )

  it('leaves the builtin objects themselves unchanged', () => {
    load('implementer')

    const builtin = BUILTIN_PROFILES.find(p => p.name === 'implementer')
    expect(builtin?.disallowedTools).not.toContain(`Write(/${agentHome}/profiles/**)`)
  })

  it('emits no rule for a home holding a comma, and says so', () => {
    const commaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc1094,'))
    fs.mkdirSync(path.join(commaHome, 'profiles'))
    try {
      const profile = loadProfile('implementer', path.join(commaHome, 'profiles'))
      if ('error' in profile) throw new Error(profile.error)

      expect(workerConfigDenies(commaHome)).toEqual([])
      expect(profile.disallowedTools?.some(rule => rule.includes(commaHome))).toBe(false)
      expect(profile.warnings).toEqual([expect.stringContaining('contains a comma')])
    } finally {
      fs.rmSync(commaHome, { recursive: true, force: true })
    }
  })
})
