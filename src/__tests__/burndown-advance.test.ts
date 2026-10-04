import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { observe } from '../agents/burndown/observe.js'
import { parseReport } from '../agents/burndown/report.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import type { AgentIdentity } from '../protocol.js'

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
const registers = (actions: Action[]) => actions.filter(a => a.kind === 'register')

const PR = 'https://github.com/o/r/pull/9'
const row = (phase: ShepherdRow['phase'], stalled: string | null = null): ShepherdRow => ({
  repo: 'o/r',
  pr: 9,
  runId: 'run-9',
  phase,
  headSha: 'h9',
  stalled: stalled === null ? null : { reason: stalled },
})

describe('burndown phase machine', () => {
  it('spawns one reviewer when an implementer exits with a reviewable diff and no PR', () => {
    const { actions, after } = step(claim(), {
      agent: exited,
      report: parseReport('Status: DONE_WITH_CONCERNS'),
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
    const shepherding = claim({
      phase: 'shepherding',
      pr: PR,
      spawned: ['bd-cc-1', 'bd-cc-1-r0', 'bd-cc-1-s1', 'bd-cc-1-r1'],
    })

    const { actions, after } = step(shepherding, { shepherd: { row: row('done'), landed: true } })

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

  it.each([
    ['over 3 points', 'slice a: 5 points, over the 3-point limit'],
    ['with no owns', 'slice a: owns no files'],
    ['with an unknown dep', 'slice a: depends on unknown slice z'],
  ])('stalls the planning phase on a slice %s with its lint reason (CC-631)', (_, reason) => {
    const planning = claim({ phase: 'planning', worktree: undefined })

    const { actions, after } = step(planning, {
      agent: exited,
      sliceProblems: [reason, 'slice b: no points'],
    })

    expect(spawns(actions)).toEqual([])
    expect(after).toEqual([
      expect.objectContaining({ phase: 'planning', stalledReason: `${reason}\nslice b: no points` }),
    ])
  })

  it('stalls a planner whose plan file fails the lint with each reason line, read through observe', async () => {
    const planning = claim({ phase: 'planning', worktree: undefined })
    const slices = [
      { n: 'a', title: 'x', points: 5, doneWhen: 'a test passes', owns: ['src/a.ts'] },
      { n: 'b', title: 'y', points: 1, doneWhen: 'b test passes', owns: [] },
      { n: 'c', title: 'z', points: 1, doneWhen: 'c test passes', dependsOn: ['q'], owns: ['src/c.ts'] },
    ]
    const plan = `# Plan\n\`\`\`burndown-slices\n${JSON.stringify(slices)}\n\`\`\`\n`
    const row = { agentId: 'a1', name: 'bd-cc-1', state: 'exited', spawnedAt: 1 } as AgentIdentity
    const { observations } = await observe(
      [planning],
      { agents: [row] },
      {
        root: '/active-work',
        inboxSince: async () => [],
        finalText: () => 'Status: DONE',
        readFile: () => plan,
      },
    )

    const { after } = step(planning, observations.get(claimKey(planning)) ?? {})

    expect(after.map(c => c.stalledReason?.split('\n'))).toEqual([
      [
        'slice a: 5 points, over the 3-point limit',
        'slice b: owns no files',
        'slice c: depends on unknown slice q',
      ],
    ])
  })

  it('keeps the generic stall for a planner with no slices and no reasons', () => {
    const { after } = step(claim({ phase: 'planning', worktree: undefined }), { agent: exited })

    expect(after).toEqual([
      expect.objectContaining({ stalledReason: 'planner left no machine-readable slices' }),
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

describe('burndown hands a PR to Shepherd', () => {
  it("registers a DONE worker's PR and moves the claim to shepherding without a reviewer", () => {
    const { actions, after } = step(claim(), {
      agent: exited,
      report: parseReport(`Status: DONE\nPR: ${PR}`),
      diff: { reviewable: true, reason: '2 commits ahead' },
    })

    expect(spawns(actions)).toEqual([])
    expect(registers(actions)).toEqual([
      expect.objectContaining({
        registration: { target: { repo: 'o/r', pr: 9 }, task: 'demo/CC-1', implementer: 'bd-cc-1' },
      }),
    ])
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', pr: PR })])
  })

  it('stalls a DONE worker whose PR is not a GitHub PR, registering nothing', () => {
    const { actions, after } = step(claim(), {
      agent: exited,
      report: parseReport('Status: DONE\nPR: https://example.test/o/r/pull/9'),
    })

    expect(registers(actions)).toEqual([])
    expect(after).toEqual([
      expect.objectContaining({
        stalledReason: expect.stringContaining('not a GitHub PR Shepherd can take'),
      }),
    ])
  })

  it('registers an approved PR Shepherd does not hold, and only moves one it already holds', () => {
    const reviewing = claim({ phase: 'reviewing', agentName: 'bd-cc-1-r0', pr: PR })
    const approve = { agent: exited, report: parseReport('Verdict: APPROVE') }

    const fresh = step(reviewing, { ...approve, shepherd: {} })
    const held = step(reviewing, { ...approve, shepherd: { row: row('ci') } })

    expect(registers(fresh.actions)).toHaveLength(1)
    expect(registers(held.actions)).toEqual([])
    expect([...fresh.after, ...held.after]).toEqual([
      expect.objectContaining({ phase: 'shepherding' }),
      expect.objectContaining({ phase: 'shepherding' }),
    ])
  })

  it('waits without registering again while Shepherd holds the PR in flight', () => {
    const shepherding = claim({ phase: 'shepherding', pr: PR })

    const phases = ['ci', 'fixing', 'review', 'awaiting-approval', 'merging'] as const

    expect(phases.flatMap(p => step(shepherding, { shepherd: { row: row(p) } }).actions)).toEqual([])
  })

  it('registers again when Shepherd has no row, as after an unanswered register', () => {
    const { actions } = step(claim({ phase: 'shepherding', pr: PR }), { shepherd: {} })

    expect(registers(actions)).toHaveLength(1)
  })

  it('finishes on post-merge, and stalls a finished run that never landed', () => {
    const shepherding = claim({ phase: 'shepherding', pr: PR })

    const merged = step(shepherding, { shepherd: { row: row('post-merge') } })
    const closed = step(shepherding, { shepherd: { row: row('done'), landed: false } })
    const failed = step(shepherding, { shepherd: { row: row('failed', 'merge denied') } })

    expect(merged.after).toEqual([expect.objectContaining({ phase: 'done', prHead: 'h9' })])
    expect(closed.after).toEqual([
      expect.objectContaining({ stalledReason: 'Shepherd run run-9 ended done without merging' }),
    ])
    expect(failed.after).toEqual([
      expect.objectContaining({
        stalledReason: 'Shepherd run run-9 ended failed without merging: merge denied',
      }),
    ])
  })

  it('moves an awaiting-merge claim from before Shepherd onto it', () => {
    const awaiting = claim({ phase: 'awaiting-merge', pr: PR })

    const unheld = step(awaiting, { shepherd: {} })
    const held = step(awaiting, { shepherd: { row: row('ci') } })

    expect(registers(unheld.actions)).toHaveLength(1)
    expect([...unheld.after, ...held.after].map(c => c.phase)).toEqual(['shepherding', 'shepherding'])
  })

  it('stalls a shepherding claim with no PR recorded', () => {
    const { after } = step(claim({ phase: 'shepherding' }), {})

    expect(after).toEqual([
      expect.objectContaining({ stalledReason: 'no PR recorded for Shepherd to merge' }),
    ])
  })
})
