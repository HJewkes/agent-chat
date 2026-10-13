import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { observe, type ObserveDeps } from '../agents/burndown/observe.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1066: a finished worker's DONE+PR hand-off is fenced on the PR's own files, not only the local diff. */

const NOW = new Date('2026-10-13T12:00:00.000Z')
const EARLIER = '2026-10-13T11:00:00.000Z'
const PR = 'https://github.com/o/r/pull/9'
const OUTSIDE = 'src/other/x.ts'

const row = { agentId: 'a1', name: 'bd-cc-1', state: 'exited', spawnedAt: 1 } as AgentIdentity

function step(c: Claim, obs: Observation): { actions: Action[]; after: Claim[] } {
  const actions = advance([c], new Map([[claimKey(c), obs]]), NOW)
  return { actions, after: applyActions({ ...EMPTY_LEDGER, claims: [c] }, actions, NOW).claims }
}

const kinds = (actions: Action[]): Action['kind'][] => actions.map(a => a.kind)

describe('a DONE+PR hand-off is fenced by the PR files (CC-1066)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-done-pr-')))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const claim = (patch: Partial<Claim> = {}): Claim => ({
    taskId: 'CC-1',
    initiative: 'demo',
    slice: 'a',
    agentId: 'a1',
    agentName: 'bd-cc-1',
    spawned: ['bd-cc-1'],
    worktree: dir,
    spawnedAt: EARLIER,
    phase: 'implementing',
    phaseAt: EARLIER,
    owns: ['src/a.ts'],
    ...patch,
  })

  const cleanDeps = (over: Partial<ObserveDeps>): ObserveDeps => ({
    root: '/active-work',
    inboxSince: async () => [],
    finalText: () => `Status: DONE\nPR: ${PR}`,
    diff: () => ({ reviewable: false, reason: 'clean and level' }),
    changedFiles: () => [],
    ...over,
  })

  const observed = async (c: Claim, deps: ObserveDeps): Promise<Observation> =>
    (await observe([c], { agents: [row] }, deps)).observations.get(claimKey(c)) ?? {}

  const counting = (files: string[] | undefined) => {
    const calls = { n: 0 }
    return { calls, prFiles: () => ((calls.n += 1), files) }
  }

  it.each(['DONE', 'DONE_WITH_CONCERNS'])(
    'stalls a %s worker with a clean worktree whose PR touches a file outside owns',
    async status => {
      const c = claim()

      const obs = await observed(
        c,
        cleanDeps({ finalText: () => `Status: ${status}\nPR: ${PR}`, prFiles: () => ['src/a.ts', OUTSIDE] }),
      )
      const { actions, after } = step(c, obs)

      expect(obs.owned).toEqual({ outside: [OUTSIDE] })
      expect(kinds(actions)).not.toContain('register')
      expect(after).toEqual([expect.objectContaining({ phase: 'implementing', stallCode: 'outside-owns' })])
    },
  )

  it('hands a DONE worker whose PR stays inside owns to Shepherd', async () => {
    const c = claim()

    const obs = await observed(c, cleanDeps({ prFiles: () => ['src/a.ts'] }))
    const { actions, after } = step(c, obs)

    expect(kinds(actions)).toContain('register')
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', pr: PR })])
  })

  it('waits a tick when the PR files cannot be read', async () => {
    const c = claim()

    const obs = await observed(c, cleanDeps({ prFiles: () => undefined }))

    expect(obs.owned).toBe('unreadable')
    expect(step(c, obs).actions).toEqual([])
  })

  it.each(['none', '#871', 'https://gitlab.com/o/r/-/merge_requests/9'])(
    'stalls a DONE worker whose PR line is %s on the first tick, reading no PR files',
    async line => {
      const c = claim()
      const { calls, prFiles } = counting(['src/a.ts'])

      const obs = await observed(c, cleanDeps({ finalText: () => `Status: DONE\nPR: ${line}`, prFiles }))
      const { after } = step(c, obs)

      expect(calls.n).toBe(0)
      expect(after).toEqual([
        expect.objectContaining({ stalledReason: expect.stringContaining('not a GitHub PR') }),
      ])
    },
  )

  it('reads the claim PR when the DONE report names none', async () => {
    const c = claim({ pr: PR })
    const { calls, prFiles } = counting(['src/a.ts', OUTSIDE])

    const obs = await observed(c, cleanDeps({ finalText: () => 'Status: DONE', prFiles }))

    expect(calls.n).toBe(1)
    expect(obs.owned).toEqual({ outside: [OUTSIDE] })
  })

  it.each([
    ['a DONE report with no PR known', 'Status: DONE'],
    ['a BLOCKED report with a PR line', `Status: BLOCKED\nPR: ${PR}`],
  ])('reads no PR files for %s', async (_case, text) => {
    const { calls, prFiles } = counting([])

    await observed(claim(), cleanDeps({ finalText: () => text, prFiles }))

    expect(calls.n).toBe(0)
  })

  it('reads a parked tree claim PR once', async () => {
    const { calls, prFiles } = counting(['src/a.ts'])

    await observed(claim({ worktree: undefined, pr: PR }), cleanDeps({ prFiles }))

    expect(calls.n).toBe(1)
  })

  it('clears a PR-file stall once the plan widens the slice owns', async () => {
    const plan = [
      '```burndown-slices',
      JSON.stringify([{ n: 'a', title: 't', points: 1, doneWhen: 'd', owns: ['src/a.ts', OUTSIDE] }]),
      '```',
    ].join('\n')
    const stalled = claim({ pr: PR, stallCode: 'outside-owns', stalledReason: `touches ${OUTSIDE}` })

    const obs = await observed(
      stalled,
      cleanDeps({ readFile: () => plan, prFiles: () => ['src/a.ts', OUTSIDE] }),
    )
    const { actions, after } = step(stalled, obs)

    expect(obs.owned).toEqual({ outside: [] })
    expect(kinds(actions)).toContain('register')
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', stallCode: undefined })])
  })
})
