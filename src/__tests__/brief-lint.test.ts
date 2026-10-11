import { describe, expect, it } from 'vitest'
import { lintBrief, repoVisibilityReader, type BriefLintInput } from '../agents/brief-lint.js'
import { BUILTIN_PROFILES } from '../agents/profiles.js'

const implementer = BUILTIN_PROFILES.find(p => p.name === 'implementer')!

const lint = (over: Partial<BriefLintInput>) =>
  lintBrief({ brief: '', profile: implementer, surface: 'headless', repoVisibility: 'unknown', ...over })

describe('the brief lint refuses a tool the agent cannot use', () => {
  it('refuses a headless implementer asked to use ScheduleWakeup, naming both', () => {
    const result = lint({ brief: 'Open the PR, then use ScheduleWakeup to check back on CI.' })

    expect(result.refusal).toContain('implementer')
    expect(result.refusal).toContain('ScheduleWakeup')
  })

  it('refuses an agent-chat verb the profile denies, naming the profile and the verb', () => {
    const result = lint({
      brief: 'When done, run agent-chat agent spawn for a reviewer.',
      surface: 'iterm-pane',
    })

    expect(result.refusal).toContain('implementer')
    expect(result.refusal).toContain('agent-chat agent')
  })

  it('refuses a CamelCase tool the profile denies on any surface', () => {
    const result = lint({ brief: 'Use AskUserQuestion if unsure.', surface: 'iterm-pane' })

    expect(result.refusal).toContain('AskUserQuestion')
  })

  it('does not refuse a negated mention', () => {
    expect(lint({ brief: 'Never use ScheduleWakeup; you are headless.' }).refusal).toBeUndefined()
    expect(lint({ brief: "Don't run agent-chat agent spawn yourself." }).refusal).toBeUndefined()
  })

  it('does not refuse ScheduleWakeup for an agent in a visible pane', () => {
    const result = lint({ brief: 'Use ScheduleWakeup to check back on CI.', surface: 'iterm-pane' })

    expect(result.refusal).toBeUndefined()
  })

  it('does not refuse a plain-English word that is also a denied tool name', () => {
    const explorer = BUILTIN_PROFILES.find(p => p.name === 'explorer')!

    expect(lint({ brief: 'Write the findings up as a list.', profile: explorer }).refusal).toBeUndefined()
  })

  it('refuses a request even when a negation follows it in the sentence', () => {
    expect(lint({ brief: 'Use ScheduleWakeup, no need to poll.' }).refusal).toContain('ScheduleWakeup')
  })
})

describe('the brief lint only warns on a tool it names without asking for it', () => {
  it('does not refuse a done-when line naming a denied agent-chat verb, and warns instead', () => {
    const brief = 'Done when: agent-chat agent spawn and agent resume accept --remote-control.'

    const result = lint({ brief })

    expect(result.refusal).toBeUndefined()
    expect(result.warnings).toEqual([expect.stringContaining('agent-chat agent')])
  })

  it('does not refuse a task that describes the lint itself', () => {
    const brief = 'Done when: A test brief naming ScheduleWakeup for a headless implementer is refused.'

    expect(lint({ brief }).refusal).toBeUndefined()
  })

  it('ignores a Bash deny that is not an agent-chat verb', () => {
    const reviewer = BUILTIN_PROFILES.find(p => p.name === 'reviewer')!

    const result = lint({
      brief: 'Run git stash before checking out.',
      profile: reviewer,
      surface: 'iterm-pane',
    })

    expect(result).toEqual({ warnings: [] })
  })
})

describe('the brief lint warns on a public repo with no synthetic-data line', () => {
  it('warns once for a public repo without a synthetic-data line', () => {
    expect(lint({ brief: 'Fix the parser.', repoVisibility: 'public' }).warnings).toHaveLength(1)
  })

  it('does not warn when the brief has a synthetic-data line', () => {
    const brief = 'Fix the parser. Use synthetic data in fixtures.'

    expect(lint({ brief, repoVisibility: 'public' }).warnings).toEqual([])
  })

  it('does not warn when the visibility is unknown', () => {
    expect(lint({ brief: 'Fix the parser.', repoVisibility: 'unknown' }).warnings).toEqual([])
  })
})

describe('the repo visibility reader', () => {
  const git = async () => 'git@github.com:acme/widgets.git'

  it('reads the visibility of the origin repo once per repo', async () => {
    const calls: string[][] = []
    const read = repoVisibilityReader(git, async args => {
      calls.push([...args])
      return 'public\n'
    })

    expect(await read('/a')).toBe('public')
    expect(await read('/b')).toBe('public')
    expect(calls).toEqual([['api', 'repos/acme/widgets', '--jq', '.visibility']])
  })

  it('gives unknown when gh fails or there is no GitHub origin', async () => {
    const failing = repoVisibilityReader(git, async () => {
      throw new Error('timeout')
    })
    const noOrigin = repoVisibilityReader(
      async () => null,
      async () => 'public',
    )

    expect(await failing('/a')).toBe('unknown')
    expect(await noOrigin('/a')).toBe('unknown')
  })

  it('asks again after a failure instead of caching unknown', async () => {
    const answers = [Promise.reject(new Error('timeout')), Promise.resolve('public')]
    answers[0]?.catch(() => undefined)
    const read = repoVisibilityReader(git, () => answers.shift() ?? Promise.resolve('private'))

    expect(await read('/a')).toBe('unknown')
    expect(await read('/a')).toBe('public')
  })
})
