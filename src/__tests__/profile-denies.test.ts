import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { BUILTIN_PROFILES, loadProfile, parseProfile } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'

const INBOX = 'Bash(agent-chat inbox:*)'
const APPROVE = 'Bash(agent-chat approve:*)'
const ENDORSE = 'Bash(agent-chat endorse:*)'

const valid = { model: 'sonnet', allowedTools: ['Read', 'Bash'], isolation: 'none', surface: 'headless' }

function parsed(body: Record<string, unknown>): AgentProfile {
  const profile = parseProfile('fixture', { ...valid, ...body })
  if ('error' in profile) throw new Error(profile.error)
  return profile
}

const deniedAtLaunch = (profile: AgentProfile): string[] => {
  const { args } = buildLaunchPlan({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'scout',
    profile,
    brief: 'review the diff',
    cwd: '/repo',
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
  })
  return (args[args.indexOf('--disallowed-tools') + 1] ?? '').split(',')
}

describe('the `denies` key of a profile file (CC-558)', () => {
  // Mutation caught: ignoring the key, which is how a reviewer profile kept Monitor and ScheduleWakeup.
  it('denies its tools at launch, after the ones disallowedTools names', () => {
    const profile = parsed({ disallowedTools: ['Write'], denies: ['Monitor', 'ScheduleWakeup'] })

    expect(profile.disallowedTools).toEqual(['Write', 'Monitor', 'ScheduleWakeup'])
    expect(deniedAtLaunch(profile)).toEqual(['Write', 'Monitor', 'ScheduleWakeup'])
    expect(profile).not.toHaveProperty('warnings')
  })

  it('stands alone in a file with no disallowedTools, and repeats nothing', () => {
    expect(parsed({ denies: ['Monitor'] }).disallowedTools).toEqual(['Monitor'])
    expect(parsed({ disallowedTools: ['Monitor'], denies: ['Monitor'] }).disallowedTools).toEqual(['Monitor'])
  })

  it('refuses a value that is not a list of tools rather than dropping it', () => {
    expect(parseProfile('bad', { ...valid, denies: 'Monitor' })).toHaveProperty('error')
    expect(parseProfile('bad', { ...valid, denies: [1] })).toHaveProperty('error')
  })

  it('leaves a file that denies nothing with no deny list', () => {
    expect(parsed({})).not.toHaveProperty('disallowedTools')
    expect(parsed({ disallowedTools: [] }).disallowedTools).toEqual([])
  })
})

describe('the inbox deny on a profile file (CC-558)', () => {
  // Mutation caught: trusting the file, which leaves `inbox --batch --answers` open to a profile that denies approve.
  it.each([
    [
      'a coordinator that denies the human verbs',
      { role: 'coordinator', disallowedTools: [APPROVE, ENDORSE] },
    ],
    ['a worker that denies only approve', { disallowedTools: ['Write', APPROVE] }],
    ['a worker that denies only endorse', { disallowedTools: [ENDORSE] }],
    ['a file that names approve under the alias', { denies: [APPROVE] }],
  ])('adds it to %s, and says so', (_shape, body) => {
    const profile = parsed(body)

    expect(profile.disallowedTools?.filter(tool => tool === INBOX)).toEqual([INBOX])
    expect(deniedAtLaunch(profile)).toContain(INBOX)
    expect(profile.warnings).toEqual([expect.stringMatching(/fixture\.json.*agent-chat inbox/)])
  })

  it('adds nothing to a file that already denies it', () => {
    const profile = parsed({ disallowedTools: [APPROVE, INBOX] })

    expect(profile.disallowedTools).toEqual([APPROVE, INBOX])
    expect(profile).not.toHaveProperty('warnings')
  })

  it('keeps inbox for a profile that allows it by name, as the decider does', () => {
    const profile = parsed({ allowedTools: ['Read', INBOX], disallowedTools: [APPROVE, ENDORSE] })
    const shipped = loadProfile('decider', path.join(__dirname, '../../profiles'))

    expect(profile.disallowedTools).toEqual([APPROVE, ENDORSE])
    expect(profile).not.toHaveProperty('warnings')
    expect(shipped).not.toHaveProperty('error')
    expect((shipped as AgentProfile).disallowedTools).not.toContain(INBOX)
  })

  it('leaves a file that denies neither verb alone', () => {
    expect(parsed({ disallowedTools: ['Bash'] }).disallowedTools).toEqual(['Bash'])
  })

  it('holds for every builtin that denies approve', () => {
    for (const builtin of BUILTIN_PROFILES.filter(p => p.disallowedTools?.includes(APPROVE)))
      expect(builtin.disallowedTools).toContain(INBOX)
  })
})
