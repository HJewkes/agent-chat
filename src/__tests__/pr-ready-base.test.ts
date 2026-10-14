import { describe, expect, it } from 'vitest'
import { resolveBase } from '../cli/verbs/pr-ready-base.js'
import type { Run, RunResult } from '../cli/verbs/pr-ready.js'

const DEF = 'refs/remotes/origin/main'
const ORIGIN = 'refs/remotes/origin/'
const PARENT = `${ORIGIN}agent-chat/p`
const GRANDPARENT = `${ORIGIN}agent-chat/g`
const OTHER = `${ORIGIN}agent-chat/o`

const ok = (output = ''): RunResult => ({ code: 0, output })
const fails: RunResult = { code: 1, output: 'synthetic failure' }
const prList = (head: string) => `gh pr list --head ${head} --state open --json number,baseRefName`
const forEachRef = `git for-each-ref --format=%(refname) --merged HEAD --no-merged ${DEF} ${ORIGIN}`
const record = 'git config --get branch.feature.agent-chat-base'

/**
 * Answers by command line. Unlisted commands fail, except check-ref-format, which accepts any
 * name not starting with `-`, and merge-base, which reads `ancestors` as "a is an ancestor of b".
 */
function fakeRun(answers: Record<string, RunResult>, ancestors: [string, string][] = []) {
  const calls: string[] = []
  const run: Run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    const answer = answers[line]
    if (answer !== undefined) return answer
    const [verb, , name = ''] = args
    if (verb === 'check-ref-format') return name.startsWith('-') ? fails : ok(name)
    if (args[0] === 'merge-base')
      return ancestors.some(([a, b]) => a === args[2] && b === args[3]) ? ok() : fails
    return fails
  }
  return { run, calls }
}

const onFeature = (answers: Record<string, RunResult>, ancestors: [string, string][] = []) =>
  fakeRun({ 'git symbolic-ref --quiet --short HEAD': ok('feature\n'), ...answers }, ancestors)

describe('pr-ready base resolution (CC-1281)', () => {
  it('uses the open PR base branch', async () => {
    const { run } = onFeature({ [prList('feature')]: ok('[{"number":9,"baseRefName":"agent-chat/p"}]') })

    expect(await resolveBase(run, '/w', DEF)).toEqual({ ref: PARENT, reason: `${PARENT} (PR #9 base)` })
  })

  it('prefers the open PR base over a recorded base', async () => {
    const { run } = onFeature({
      [prList('feature')]: ok('[{"number":9,"baseRefName":"agent-chat/p"}]'),
      [record]: ok('agent-chat/o\n'),
    })

    expect((await resolveBase(run, '/w', DEF)).ref).toBe(PARENT)
  })

  it('refuses when the branch has several open PRs, naming each', async () => {
    const two = '[{"number":9,"baseRefName":"agent-chat/p"},{"number":10,"baseRefName":"main"}]'
    const { run } = onFeature({ [prList('feature')]: ok(two) })

    await expect(resolveBase(run, '/w', DEF)).rejects.toThrow('#9 -> agent-chat/p, #10 -> main')
  })

  it('uses the recorded base when there is no open PR', async () => {
    const { run } = onFeature({ [prList('feature')]: ok('[]'), [record]: ok('agent-chat/p\n') })

    expect(await resolveBase(run, '/w', DEF)).toEqual({ ref: PARENT, reason: `${PARENT} (recorded)` })
  })

  it('refuses a recorded base that is not a branch name', async () => {
    const { run } = onFeature({ [prList('feature')]: ok('[]'), [record]: ok('-x\n') })

    await expect(resolveBase(run, '/w', DEF)).rejects.toThrow(
      'branch.feature.agent-chat-base is -x, not a branch name',
    )
  })

  it("infers the one stacked parent with an open PR, ignoring the branch's own origin ref", async () => {
    const { run } = onFeature({
      [forEachRef]: ok(`${PARENT}\n${ORIGIN}feature\n`),
      [prList('agent-chat/p')]: ok('[{"number":5}]'),
    })

    expect(await resolveBase(run, '/w', DEF)).toEqual({
      ref: PARENT,
      reason: `${PARENT} (stacked on origin/agent-chat/p (PR #5))`,
    })
  })

  it('ignores an upstream that is the branch pushed under another name', async () => {
    const { run } = onFeature({
      [forEachRef]: ok(`${ORIGIN}pr-head\n`),
      'git rev-parse --symbolic-full-name @{upstream}': ok(`${ORIGIN}pr-head\n`),
    })

    expect(await resolveBase(run, '/w', DEF)).toEqual({ ref: DEF, reason: DEF })
  })

  it('picks the nearest of nested stacked parents', async () => {
    const { run } = onFeature(
      { [forEachRef]: ok(`${GRANDPARENT}\n${PARENT}\n`), [prList('agent-chat/p')]: ok('[{"number":5}]') },
      [[GRANDPARENT, PARENT]],
    )

    expect((await resolveBase(run, '/w', DEF)).ref).toBe(PARENT)
  })

  it('refuses two unrelated stacked parents, naming both and the git config remedy', async () => {
    const { run } = onFeature({ [forEachRef]: ok(`${PARENT}\n${OTHER}\n`) })

    await expect(resolveBase(run, '/w', DEF)).rejects.toThrow(
      'HEAD contains commits of origin/agent-chat/p, origin/agent-chat/o not on origin/main; cannot tell the ' +
        'base: record it with git config branch.feature.agent-chat-base <name> (use main if the parent merged)',
    )
  })

  it.each([
    ['has no open PR', ok('[]')],
    ['cannot be looked up', fails],
  ])('refuses a stacked parent that %s', async (_, answer) => {
    const { run } = onFeature({ [forEachRef]: ok(`${PARENT}\n`), [prList('agent-chat/p')]: answer })

    await expect(resolveBase(run, '/w', DEF)).rejects.toThrow('HEAD contains commits of origin/agent-chat/p')
  })

  it('falls back to the default branch, reason the bare ref, when gh fails and nothing is stacked', async () => {
    const { run } = onFeature({ [forEachRef]: ok('') })

    expect(await resolveBase(run, '/w', DEF)).toEqual({ ref: DEF, reason: DEF })
  })

  it('uses the default branch on a detached HEAD without asking gh', async () => {
    const { run, calls } = fakeRun({})

    expect(await resolveBase(run, '/w', DEF)).toEqual({ ref: DEF, reason: DEF })
    expect(calls.filter(call => call.startsWith('gh '))).toEqual([])
  })
})
