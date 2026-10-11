import { describe, expect, it } from 'vitest'
import { lintBrief, repoVisibilityReader, type BriefLintInput } from '../agents/brief-lint.js'
import { BUILTIN_PROFILES } from '../agents/profiles.js'

const implementer = BUILTIN_PROFILES.find(p => p.name === 'implementer')!

const lint = (over: Partial<BriefLintInput>) =>
  lintBrief({ brief: '', profile: implementer, surface: 'headless', repoVisibility: 'unknown', ...over })

describe('the brief lint refuses a tool the agent cannot use', () => {
  it('refuses a headless implementer asked to use ScheduleWakeup, naming both', () => {
    const result = lint({ brief: 'Open the PR.\nUse ScheduleWakeup to check back on CI.' })

    expect(result.refusal).toContain('implementer')
    expect(result.refusal).toContain('ScheduleWakeup')
  })

  it('refuses an agent-chat verb the profile denies, naming the profile and the verb', () => {
    const result = lint({
      brief: 'Run agent-chat agent spawn for a reviewer when done.',
      surface: 'iterm-pane',
    })

    expect(result.refusal).toContain('implementer')
    expect(result.refusal).toContain('agent-chat agent')
  })

  it('refuses a CamelCase tool the profile denies on any surface', () => {
    const result = lint({ brief: 'Use AskUserQuestion if unsure.', surface: 'iterm-pane' })

    expect(result.refusal).toContain('AskUserQuestion')
  })

  it.each([
    'Never use ScheduleWakeup; you are headless.',
    "Don't run agent-chat agent spawn yourself.",
    'Do not use AskUserQuestion.',
    'You cannot use AskUserQuestion.',
    "You can't use AskUserQuestion.",
    "There is nobody to answer, so you mustn't call AskUserQuestion.",
    "You won't need to use ScheduleWakeup.",
    "You shouldn't invoke CronCreate.",
    'Rather than use ScheduleWakeup, report and exit.',
    'Instead of using ScheduleWakeup, report and exit.',
    'Avoid calling AskUserQuestion.',
    'It is forbidden to use AskUserQuestion here.',
    'Your profile denies agent-chat agent, so ask your spawner to run it.',
    'You must not, under any circumstances, use AskUserQuestion.',
    'Never sleep, call ScheduleWakeup, or poll CI.',
    'Never:\n- use AskUserQuestion\n- push to main',
    '## Do not\n1. run agent-chat agent spawn',
    'Do not stop to ask the owner, use AskUserQuestion, or wait for input.',
    'Forbidden here: run agent-chat agent spawn.',
    'Use ScheduleWakeup? No.',
    'Use ScheduleWakeup, no need to poll.',
    'You are headless, so you must never\nuse ScheduleWakeup or sleep.',
    'Never:\n- stop for input, or\n  use AskUserQuestion',
    'Do not block on the owner (i.e. use AskUserQuestion) at any point.',
    'Do not wait for CI, e.g. call ScheduleWakeup.',
    '## Never\n\nUse AskUserQuestion to ask the owner.',
    'You must never:\nuse AskUserQuestion',
    'Stay quiet.\nNever wait.\nUse ScheduleWakeup instead? No.',
  ])('does not refuse a prohibition or description: %s', brief => {
    expect(lint({ brief }).refusal).toBeUndefined()
  })

  it.each([
    '- run agent-chat agent spawn for the reviewer.',
    'Steps:\n1. Open the PR.\n2. Then call AskUserQuestion.',
    'Never push to main.\n\nPlease invoke CronCreate every hour.',
    'Open the PR. Use ScheduleWakeup to check back on CI.',
    '## Steps\n\nOpen the PR and wait for\nreview.\n\n- Then run agent-chat agent spawn for a reviewer.',
  ])('refuses an imperative sentence in another position: %s', brief => {
    expect(lint({ brief }).refusal).toBeDefined()
  })

  it('does not refuse ScheduleWakeup for an agent in a visible pane', () => {
    const result = lint({ brief: 'Use ScheduleWakeup to check back on CI.', surface: 'iterm-pane' })

    expect(result.refusal).toBeUndefined()
  })

  it('does not refuse a plain-English word that is also a denied tool name', () => {
    const explorer = BUILTIN_PROFILES.find(p => p.name === 'explorer')!

    expect(lint({ brief: 'Write the findings up as a list.', profile: explorer }).refusal).toBeUndefined()
  })
})

describe('the brief lint only warns on a tool it names without asking for it', () => {
  it('does not refuse a done-when line naming a denied agent-chat verb, and warns instead', () => {
    const brief = 'Done when: agent-chat agent spawn and agent resume accept --remote-control.'

    const result = lint({ brief })

    expect(result.refusal).toBeUndefined()
    expect(result.warnings).toEqual([expect.stringContaining('agent-chat agent')])
  })

  it('only warns on a request in the middle of a sentence', () => {
    const result = lint({ brief: 'Open the PR, then use ScheduleWakeup to check back on CI.' })

    expect(result.refusal).toBeUndefined()
    expect(result.warnings).toEqual([expect.stringContaining('ScheduleWakeup')])
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
