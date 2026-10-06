import { describe, expect, it } from 'vitest'
import { claimCustody, custodyOf, type CustodyFacts } from '../agents/burndown/custody.js'
import type { Claim } from '../agents/burndown/ledger.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import type { DispatchRecord } from '../agents/seats/dispatch-record.js'

const NOW = new Date('2026-10-06T12:00:00Z')
const PR = 'demo/repo#7'

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'DM-1',
  initiative: 'demo',
  spawnedAt: '2026-10-06T11:00:00Z',
  phase: 'implementing',
  phaseAt: '2026-10-06T11:30:00Z',
  ...over,
})

const row = (over: Partial<ShepherdRow> = {}): ShepherdRow => ({
  repo: 'demo/repo',
  pr: 7,
  runId: 'r1',
  phase: 'ci',
  headSha: null,
  stalled: null,
  ...over,
})

const claimFacts = (c: Claim, shepherd: readonly ShepherdRow[] = []): CustodyFacts => ({
  kind: 'claim',
  claim: c,
  now: NOW,
  shepherd,
})

const unreadable = (c: Claim): CustodyFacts => ({ kind: 'claim', claim: c, now: NOW, shepherd: undefined })

const run = (over: Partial<DispatchRecord> = {}): DispatchRecord =>
  ({
    agent: 'a',
    task: 'DM-1',
    outcome: 'parked',
    note: null,
    profile: 'implementer',
    ...over,
  }) as DispatchRecord

describe('custodyOf, one row per state', () => {
  it.each([
    ['building', claim({ phase: 'implementing' })],
    ['in review', claim({ phase: 'reviewing' })],
    ['waiting on owner', claim({ phase: 'parked' })],
    ['waiting on world', claim({ phase: 'awaiting-merge' })],
    ['being fixed', claim({ phase: 'shepherding', pr: PR })],
    ['unowned', claim({ phase: 'shepherding' })],
  ] as const)('gives %s', (word, c) => {
    const shepherd = word === 'being fixed' ? [row({ phase: 'fixing' })] : []
    expect(custodyOf(claimFacts(c, shepherd)).word).toBe(word)
  })

  it('names the shepherd phase for a shepherded PR', () => {
    expect(
      custodyOf(claimFacts(claim({ phase: 'shepherding', pr: PR }), [row({ phase: 'review' })])),
    ).toEqual({
      word: 'in review',
      reason: 'shepherd: PR in review',
    })
    expect(custodyOf(claimFacts(claim({ phase: 'shepherding', pr: PR }), [row({ phase: 'ci' })])).word).toBe(
      'waiting on world',
    )
    expect(
      custodyOf(claimFacts(claim({ phase: 'shepherding', pr: PR }), [row({ phase: 'awaiting-approval' })]))
        .word,
    ).toBe('waiting on owner')
  })

  it('matches the shepherd row case-insensitively on the repo', () => {
    const c = claim({ phase: 'shepherding', pr: 'Demo/Repo#7' })
    expect(custodyOf(claimFacts(c, [row({ phase: 'fixing' })])).word).toBe('being fixed')
  })
})

describe('custodyOf, unreadable facts', () => {
  it('is unowned when the phase is missing', () => {
    const c = { ...claim(), phase: undefined } as unknown as Claim
    expect(custodyOf(claimFacts(c))).toEqual({ word: 'unowned', reason: 'claim phase unreadable' })
  })

  it('is unowned when shepherd could not be read for a shepherding claim', () => {
    expect(custodyOf(unreadable(claim({ phase: 'shepherding', pr: PR })))).toEqual({
      word: 'unowned',
      reason: 'shepherd unreadable',
    })
  })

  it('is unowned when a shepherding claim has no shepherd row', () => {
    expect(custodyOf(claimFacts(claim({ phase: 'shepherding', pr: PR }), [])).reason).toBe(
      'no shepherd run for the PR',
    )
  })

  it('is unowned when the shepherd phase is one this build does not know', () => {
    expect(
      custodyOf(claimFacts(claim({ phase: 'shepherding', pr: PR }), [row({ phase: 'unknown' })])).word,
    ).toBe('unowned')
  })

  it('does not need shepherd for a claim that is not shepherded', () => {
    expect(custodyOf(unreadable(claim({ phase: 'implementing' }))).word).toBe('building')
  })

  it('is unowned when a run has no outcome', () => {
    expect(
      custodyOf({ kind: 'run', run: { ...run(), outcome: undefined } as unknown as DispatchRecord }).word,
    ).toBe('unowned')
  })
})

describe('custodyOf, first match wins', () => {
  it('puts a stall ahead of the phase it stalled in', () => {
    const c = claim({ phase: 'implementing', stalledReason: 'phase-timeout: slow' })
    expect(custodyOf(claimFacts(c))).toEqual({
      word: 'waiting on owner',
      reason: 'stalled: phase-timeout: slow',
    })
  })

  it('treats a claim past its phase timeout as stalled', () => {
    const c = claim({ phase: 'planning', phaseAt: '2026-10-01T00:00:00Z' })
    expect(custodyOf(claimFacts(c)).word).toBe('waiting on owner')
  })

  it('puts a running triage job ahead of the stall', () => {
    const c = claim({
      stalledReason: 'no-progress: idle',
      triage: { occurrence: '2026-10-06T11:30:00Z no-progress: idle', outcome: 'started', name: 't1' },
    } as Partial<Claim>)
    expect(custodyOf(claimFacts(c)).word).toBe('being fixed')
  })

  it('ignores a triage record for an earlier stall', () => {
    const c = claim({
      stalledReason: 'no-progress: idle',
      triage: { occurrence: 'older', outcome: 'started', name: 't1' },
    } as Partial<Claim>)
    expect(custodyOf(claimFacts(c)).word).toBe('waiting on owner')
  })

  it('puts a shepherd stall ahead of the shepherd phase', () => {
    const c = claim({ phase: 'shepherding', pr: PR })
    const stalled = row({ phase: 'fixing', stalled: { reason: 'no progress' } })
    expect(custodyOf(claimFacts(c, [stalled]))).toEqual({
      word: 'waiting on owner',
      reason: 'shepherd stalled: no progress',
    })
  })

  it('puts the shepherd phase ahead of the claim phase', () => {
    const c = claim({ phase: 'awaiting-merge', pr: PR })
    expect(custodyOf(claimFacts(c, [row({ phase: 'fixing' })])).word).toBe('being fixed')
  })

  it('puts an unreadable shepherd ahead of everything below it', () => {
    const c = claim({ phase: 'shepherding', pr: PR, stalledReason: 'x' })
    expect(custodyOf(unreadable(c)).reason).toBe('shepherd unreadable')
  })
})

describe('custodyOf, runs', () => {
  it('reads an open implementer run as building and an open reviewer run as in review', () => {
    expect(custodyOf({ kind: 'run', run: run({ outcome: 'dispatched' }) }).word).toBe('building')
    expect(custodyOf({ kind: 'run', run: run({ outcome: 'dispatched', profile: 'bd-reviewer' }) }).word).toBe(
      'in review',
    )
  })

  it('reads a parked run with a MERGE verdict as waiting on the world, else on the owner', () => {
    expect(custodyOf({ kind: 'run', run: run({ note: 'verdict MERGE' }) }).word).toBe('waiting on world')
    expect(custodyOf({ kind: 'run', run: run({ note: 'needs a decision' }) })).toEqual({
      word: 'waiting on owner',
      reason: 'parked: needs a decision',
    })
  })

  it('does not hold an ended run', () => {
    expect(custodyOf({ kind: 'run', run: run({ outcome: 'merged' }) }).word).toBe('unowned')
  })
})

describe('claimCustody', () => {
  it('prints one line per claim as claim, word and reason', () => {
    const lines = claimCustody([claim(), claim({ taskId: 'DM-2', slice: 'a', phase: 'reviewing' })], NOW, [])
    expect(lines).toEqual(['DM-1 building: implementer working', 'DM-2/a in review: reviewer working'])
  })
})
