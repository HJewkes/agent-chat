import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { parseReport } from '../agents/burndown/report.js'

/** The phase machine over hand-built claims and observations; no broker, git or transcript. */

const NOW = new Date('2026-09-28T12:00:00.000Z')
const EARLIER = '2026-09-28T11:00:00.000Z'
const WORKTREE = '/repo/.worktrees/bd-cc-1'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  worktree: WORKTREE,
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  ...patch,
})

const exited = { id: 'a1', state: 'exited' as const }

function step(c: Claim, obs: Observation): { actions: Action[]; after: Claim[] } {
  const actions = advance([c], new Map([[claimKey(c), obs]]), NOW)
  const ledger: Ledger = { ...EMPTY_LEDGER, claims: [c] }
  return { actions, after: applyActions(ledger, actions, NOW).claims }
}

const spawns = (actions: Action[]) => actions.filter(a => a.kind === 'spawn')

describe('burndown phase machine', () => {
  it('spawns one reviewer when an implementer exits with a reviewable diff', () => {
    const { actions, after } = step(claim(), {
      agent: exited,
      report: parseReport('Status: DONE\nPR: https://github.com/o/r/pull/9'),
      diff: { reviewable: true, reason: '2 commits ahead' },
    })

    expect(spawns(actions)).toEqual([expect.objectContaining({ role: 'reviewer', name: 'bd-cc-1-r0' })])
    expect(after).toEqual([
      expect.objectContaining({ phase: 'spawning', nextPhase: 'reviewing', agentName: 'bd-cc-1-r0' }),
    ])
    const [spawning] = after
    if (spawning === undefined) throw new Error('no claim after the step')
    const landed = step(spawning, { agent: { id: 'r0', state: 'live' } }).after
    expect(landed).toEqual([expect.objectContaining({ phase: 'reviewing', agentId: 'r0' })])
  })

  it('finishes a DONE implementer with no diff without spawning a reviewer', () => {
    const { actions, after } = step(claim(), {
      agent: exited,
      report: parseReport('Status: DONE'),
      diff: { reviewable: false, reason: 'clean and level' },
    })

    expect(spawns(actions)).toEqual([])
    expect(after).toEqual([expect.objectContaining({ phase: 'done' })])
  })

  it('stalls on a second failed review and never spawns a third agent', () => {
    const reviewing = claim({ phase: 'reviewing', agentName: 'bd-cc-1-r1', reviewRound: 1, attempt: 1 })

    const { actions, after } = step(reviewing, {
      agent: exited,
      report: parseReport('Verdict: CHANGES\nThe test asserts nothing.'),
      pr: { state: 'open', checks: 'pass' },
    })

    expect(spawns(actions)).toEqual([])
    expect(after).toEqual([
      expect.objectContaining({ stalledReason: expect.stringContaining('second failed review') }),
    ])
  })

  it('sends a first failed review to a successor in the same worktree', () => {
    const reviewing = claim({ phase: 'reviewing', agentName: 'bd-cc-1-r0' })

    const { actions, after } = step(reviewing, {
      agent: exited,
      report: parseReport('Verdict: CHANGES\nThe test asserts nothing.'),
      pr: { state: 'open', checks: 'pass' },
    })

    expect(spawns(actions)).toEqual([
      expect.objectContaining({
        role: 'successor',
        name: 'bd-cc-1-s1',
        predecessor: 'bd-cc-1',
        worktree: WORKTREE,
        context: { kind: 'review', review: expect.stringContaining('asserts nothing') },
      }),
    ])
    expect(after).toEqual([
      expect.objectContaining({ reviewRound: 1, attempt: 1, nextPhase: 'implementing' }),
    ])
  })

  it('keeps a parked claim parked on an unrelated message and spawns a successor on the answer', () => {
    const parked = claim({ phase: 'parked', questionId: 'q1' })
    const unrelated = { msgId: 'm1', from: 'human', text: 'unrelated', inReplyTo: 'q0' }
    const answer = { msgId: 'm2', from: 'human', text: 'use option B', inReplyTo: 'q1' }

    const waiting = step(parked, { inbox: [unrelated] })
    const answered = step(parked, { inbox: [unrelated, answer] })

    expect(waiting.actions).toEqual([])
    expect(spawns(answered.actions)).toEqual([
      expect.objectContaining({
        role: 'successor',
        predecessor: 'bd-cc-1',
        worktree: WORKTREE,
        context: { kind: 'answer', questionId: 'q1', answer },
      }),
    ])
    expect(answered.after).toEqual([expect.objectContaining({ attempt: 1, questionId: undefined })])
  })

  it('retires successors and reviewers before the original agent once the PR merges', () => {
    const awaiting = claim({
      phase: 'awaiting-merge',
      spawned: ['bd-cc-1', 'bd-cc-1-r0', 'bd-cc-1-s1', 'bd-cc-1-r1'],
    })

    const { actions, after } = step(awaiting, { pr: { state: 'merged', checks: 'pass' } })

    expect(actions.filter(a => a.kind === 'retire')).toEqual([
      expect.objectContaining({ names: ['bd-cc-1-r1', 'bd-cc-1-s1', 'bd-cc-1-r0', 'bd-cc-1'] }),
    ])
    expect(after).toEqual([expect.objectContaining({ phase: 'done' })])
  })

  it('parks a worker whose last line names its question', () => {
    const { after } = step(claim(), {
      agent: exited,
      report: parseReport('Status: NEEDS_CONTEXT\nAsked about the schema.\nPARKED q7'),
      diff: { reviewable: false, reason: 'clean' },
    })

    expect(after).toEqual([expect.objectContaining({ phase: 'parked', questionId: 'q7' })])
  })

  it('queues one claim per planner slice with its dependencies and declared files', () => {
    const planning = claim({ phase: 'planning', worktree: undefined })

    const { after } = step(planning, {
      agent: exited,
      slices: [
        { n: 'a', title: 'ledger', dependsOn: [], owns: ['src/ledger.ts'] },
        { n: 'b', title: 'tick', dependsOn: ['a'], owns: [] },
      ],
    })

    expect(after.map(c => [c.slice, c.phase, c.dependsOn, c.owns])).toEqual([
      [undefined, 'done', undefined, undefined],
      ['a', 'queued', [], ['src/ledger.ts']],
      ['b', 'queued', ['a'], undefined],
    ])
  })

  it('stalls a spawn whose agent row never appears within ten minutes', () => {
    const spawning = claim({ phase: 'spawning', agentId: undefined, phaseAt: '2026-09-28T11:49:00.000Z' })

    const { after } = step(spawning, {})

    expect(after).toEqual([
      expect.objectContaining({ stalledReason: expect.stringContaining('never landed') }),
    ])
  })

  it('leaves a stalled claim alone even when its agent has exited', () => {
    const stalled = claim({ stalledReason: 'implementing past its timeout' })

    expect(step(stalled, { agent: exited, report: parseReport('Status: DONE') }).actions).toEqual([])
  })
})
