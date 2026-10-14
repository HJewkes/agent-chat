import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { parseReport } from '../agents/burndown/report.js'
import { classifyStale } from '../agents/burndown/stale-claim.js'

const NOW = new Date('2026-10-11T12:00:00.000Z')
const TWO_HOURS_AGO = '2026-10-11T10:00:00.000Z'
const BLOCKED = 'Status: BLOCKED\nPR: none\nThe upstream package is not released yet.'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'XX-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-xx-1-a',
  spawned: ['bd-xx-1-a'],
  spawnedAt: TWO_HOURS_AGO,
  phase: 'implementing',
  phaseAt: TWO_HOURS_AGO,
  slice: 'a',
  worktree: '/nowhere/wt-a',
  ...patch,
})

const exited: Observation['agent'] = { id: 'a1', state: 'exited' }

const step = (c: Claim, obs: Observation, now = NOW): Action[] =>
  advance([c], new Map([[claimKey(c), obs]]), now)

const staleUpdates = (actions: Action[]) =>
  actions.filter(a => a.kind === 'update' && a.patch.stale !== undefined)

const minutesAfter = (n: number): Date => new Date(NOW.getTime() + n * 60_000)

describe('applyActions stamps stalledAt (CC-1150 b)', () => {
  const stallAt = (reason: string | undefined, now: Date) => (c: Claim) =>
    applyActions(
      { ...EMPTY_LEDGER, claims: [c] },
      [{ kind: 'update', key: { taskId: 'XX-1', slice: 'a' }, patch: { stalledReason: reason } }],
      now,
    ).claims[0] as Claim

  it('stamps a new stall once, keeps the stamp on a later stall update, and drops it with the stall', () => {
    const first = stallAt('Status: BLOCKED', NOW)(claim())
    const second = stallAt('Status: BLOCKED again', minutesAfter(10))(first)
    const cleared = stallAt(
      undefined,
      minutesAfter(20),
    )({ ...second, stale: { class: 'blocked', proposed: 'p', since: 's' } })

    expect(first.stalledAt).toBe(NOW.toISOString())
    expect(second.stalledAt).toBe(NOW.toISOString())
    expect(cleared).not.toHaveProperty('stalledAt')
    expect(cleared).not.toHaveProperty('stale')
  })

  it('leaves a stall from before the stamp unstamped rather than dating it now', () => {
    const legacy = stallAt('Status: BLOCKED again', NOW)(claim({ stalledReason: 'Status: BLOCKED' }))

    expect(legacy).not.toHaveProperty('stalledAt')
  })
})

describe('advance classifies a stalled claim whose agent is gone (CC-1150 b)', () => {
  it('classifies a BLOCKED exit on the tick that stalls it, with no release', () => {
    const actions = step(claim(), { agent: exited, report: parseReport(BLOCKED) })

    expect(staleUpdates(actions)).toEqual([
      expect.objectContaining({
        patch: { stale: { class: 'blocked', proposed: expect.any(String), since: NOW.toISOString() } },
      }),
    ])
    expect(actions.map(a => a.kind)).toEqual(['update', 'update'])
  })

  it.each([
    ['a stall stamped this tick (0 min old)', { stalledAt: NOW.toISOString() }],
    ['a stall from before stalledAt', {}],
  ])('classifies %s on the first tick that sees the agent exited', (_, stamp) => {
    const stalled = claim({ stalledReason: 'Status: BLOCKED', stalledClass: 'failed', ...stamp })

    const actions = step(stalled, { agent: exited, report: parseReport(BLOCKED) })

    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'update',
        patch: { stale: expect.objectContaining({ class: 'blocked' }) },
      }),
    ])
  })

  it('classifies a claim whose agent row is gone from the roster', () => {
    const stalled = claim({ stalledReason: 'no final report', stalledClass: 'failed' })

    expect(staleUpdates(step(stalled, {}))).toHaveLength(1)
  })

  it.each([
    ['a live agent', claim({ stalledReason: 'Status: BLOCKED', stalledAt: TWO_HOURS_AGO }), 'live'],
    [
      'a pending respawn',
      claim({
        stalledReason: 'Status: BLOCKED',
        stalledAt: TWO_HOURS_AGO,
        respawn: { code: 'phase-timeout', occurrence: TWO_HOURS_AGO },
      }),
      'exited',
    ],
  ] as const)('never classifies a claim with %s, however old its stall', (_, stalled, state) => {
    expect(step(stalled, { agent: { id: 'a1', state }, report: parseReport(BLOCKED) })).toEqual([])
  })

  it('does not classify a claim already classified', () => {
    const stale = { class: 'blocked' as const, proposed: 'p', since: TWO_HOURS_AGO }
    const stalled = claim({ stalledReason: 'Status: BLOCKED', stale })

    expect(step(stalled, { agent: exited, report: parseReport(BLOCKED) })).toEqual([])
  })

  it('leaves a ladder-coded stall opened this tick to the ladder, and classifies it the tick after', () => {
    const unlanded = claim({ phase: 'spawning', phaseAt: '2026-10-10T00:00:00.000Z', agentId: undefined })
    const opened = step(unlanded, {})
    const held = applyActions({ ...EMPTY_LEDGER, claims: [unlanded] }, opened, NOW).claims[0] as Claim

    expect(opened).toEqual([
      expect.objectContaining({ patch: expect.objectContaining({ stallCode: 'spawn-never-landed' }) }),
    ])
    expect(staleUpdates(step(held, {}, minutesAfter(1)))).toEqual([
      expect.objectContaining({ patch: { stale: expect.objectContaining({ class: 'other' }) } }),
    ])
  })
})

describe('classifyStale (CC-1150 b)', () => {
  const classOf = (patch: Partial<Claim>, obs: Observation = {}) =>
    classifyStale(claim({ stalledReason: 'stalled', ...patch }), obs)

  it.each([
    [
      'DONE_WITH_CONCERNS with PR: none',
      {},
      { report: parseReport('Status: DONE_WITH_CONCERNS\nPR: none.') },
      'nothing-to-do',
    ],
    ['DONE with PR: none', {}, { report: parseReport('Status: DONE\nPR: none') }, 'nothing-to-do'],
    ['a retry-spent code', { stallCode: 'retry-spent' as const }, {}, 'retry-spent'],
    ['a closed PR', {}, { prState: { kind: 'closed' as const, pr: 'o/r#9' } }, 'pr-closed'],
    ['a BLOCKED report', {}, { report: parseReport(BLOCKED) }, 'blocked'],
    ['an outside-owns code', { stallCode: 'outside-owns' as const }, {}, 'outside-owns'],
    ['a phase timeout', { stallCode: 'phase-timeout' as const }, {}, 'timeout'],
    ['prose', { stalledReason: 'the agent wandered off' }, {}, 'other'],
    ['a DONE report naming a PR', {}, { report: parseReport('Status: DONE\nPR: o/r#9') }, 'other'],
  ])('classifies %s', (_, patch, obs, expected) => {
    expect(classOf(patch, obs).class).toBe(expected)
  })

  it('reads the date a report is blocked until after "on or after"', () => {
    const text =
      'Status: BLOCKED\nSlice c of XX-1 is blocked until a date: the plan says to run it on or after 2030-01-17'

    const verdict = classOf({ stalledReason: 'Status: BLOCKED' }, { report: parseReport(text) })

    expect(verdict).toEqual({
      class: 'date-blocked',
      until: '2030-01-17',
      proposed: 'release on or after 2030-01-17',
    })
  })

  it.each(['blocked until next Tuesday', 'blocked until 17/01/2030', 'released 2030-01-17'])(
    'reads no date from "%s"',
    reason => {
      expect(classOf({ stalledReason: reason }).class).toBe('other')
    },
  )

  it('gives every class a proposed action', () => {
    expect(classOf({ stallCode: 'retry-spent' }).proposed).toBe('release with requeue, branch kept')
  })
})

describe('classifyStale reads a silent, empty exit as nothing-to-do (CC-1230 a)', () => {
  const TD_829_REPORT = parseReport(
    "I didn't open a PR: the plan says this slice changes no repo files.\nThe worktree is clean.",
  )
  const EMPTY = { openPr: null, ahead: 0 }
  const NO_PR = { kind: 'none' as const }
  const classOf = (obs: Observation) =>
    classifyStale(claim({ stalledReason: TD_829_REPORT.firstLine }), obs).class

  it('finishes the TD-829 a shape: no status line, no commits, no PR on GitHub', () => {
    expect(classOf({ report: TD_829_REPORT, exitedWork: EMPTY, prState: NO_PR })).toBe('nothing-to-do')
  })

  it('reads a claim whose roster row is gone, so no report was read, the same way', () => {
    expect(classOf({ exitedWork: EMPTY, prState: NO_PR })).toBe('nothing-to-do')
  })

  it.each<[string, Observation]>([
    ['the exited work is unreadable', { report: TD_829_REPORT, exitedWork: 'unreadable', prState: NO_PR }],
    ['the exited work was never read', { report: TD_829_REPORT, prState: NO_PR }],
    ['commits are ahead', { report: TD_829_REPORT, exitedWork: { openPr: null, ahead: 1 }, prState: NO_PR }],
    [
      'the worktree has an open PR',
      { report: TD_829_REPORT, exitedWork: { openPr: 'o/r#9', ahead: 0 }, prState: NO_PR },
    ],
    [
      'GitHub shows an open PR',
      { report: TD_829_REPORT, exitedWork: EMPTY, prState: { kind: 'open', pr: 'o/r#9' } },
    ],
    ['the PR read is unreadable', { report: TD_829_REPORT, exitedWork: EMPTY, prState: 'unreadable' }],
    ['the PR was never read', { report: TD_829_REPORT, exitedWork: EMPTY }],
    [
      'the report parked a question',
      { report: parseReport('PARKED m-1'), exitedWork: EMPTY, prState: NO_PR },
    ],
  ])('keeps other when %s', (_, obs) => {
    expect(classOf(obs)).toBe('other')
  })

  it.each([
    ['a phase timeout', { stallCode: 'phase-timeout' as const }, 'timeout'],
    ['a retry-spent code', { stallCode: 'retry-spent' as const }, 'retry-spent'],
    ['a budget park', { stallCode: 'budget' as const }, 'other'],
    [
      'a dirty-uncommitted park, whose work ahead: 0 cannot see',
      { stallCode: 'dirty-uncommitted' as const },
      'other',
    ],
  ])('leaves %s to its own class, since a crash also leaves nothing behind', (_, patch, expected) => {
    const obs = { exitedWork: EMPTY, prState: NO_PR }

    expect(classifyStale(claim({ stalledReason: 'stalled', ...patch }), obs).class).toBe(expected)
  })
})
