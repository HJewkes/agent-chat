import { describe, expect, it } from 'vitest'
import type { Refusal } from '../agents/burndown/eligibility.js'
import type { RunResult } from '../agents/burndown/exec.js'
import type { Dispatch } from '../agents/burndown/plan.js'
import {
  compareSeat,
  parseScorePy,
  runScorePy,
  scorePyArgs,
  type CompareInput,
} from '../agents/burndown/seat-compare.js'
import type { PlacedTier, Placement } from '../agents/burndown/seat-plan.js'

/** CC-251: `burndown seats compare` over a canned, synthetic score.py `--json` output. */

const scoreRow = (id: string, score: number, patch: Record<string, unknown> = {}) => ({
  id,
  initiative: 'alpha',
  score,
  effective: score,
  kind: 'feature',
  blocked: [],
  route: 'implementer',
  title: `synthetic ${id}`,
  ...patch,
})

const SCORE_PY_STDOUT = JSON.stringify({
  order: [
    scoreRow('ZZ-1', 90),
    scoreRow('ZZ-2', 80),
    scoreRow('ZZ-3', 70, { initiative: 'beta' }),
    scoreRow('ZZ-4', 60),
    scoreRow('ZZ-5', 50),
  ],
  refused: { 'excluded-tag': 1 },
  initiatives: { alpha: 1, beta: 0.5 },
})

const dispatch = (task: string, patch: Partial<Dispatch> = {}): Dispatch =>
  ({ initiative: 'alpha', task, profile: 'bd-implementer', ...patch }) as Dispatch

const refusal = (task: string, kind: Refusal['kind'], reason: string): Refusal => ({
  initiative: 'alpha',
  task,
  kind,
  reason,
})

const input = (plan: Partial<CompareInput['plan']>, patch: Partial<CompareInput> = {}): CompareInput => ({
  score: parseScorePy(SCORE_PY_STDOUT),
  plan: { dispatch: [], refusals: [], shareCapped: {}, ...plan },
  held: new Set(),
  ...patch,
})

/** The plan's `planOrder` placement: each ID's tier, its tier 0 to 2 rows, and its intangible holds. */
const placed = (tiers: Record<string, PlacedTier>, patch: Partial<Placement> = {}): Placement => ({
  tiers,
  decaying: Object.entries(tiers).flatMap(([id, t]) =>
    t.tier <= 2 ? [{ id, initiative: 'alpha', tier: t.tier }] : [],
  ),
  intangibleHeld: [],
  ...patch,
})

const explained = {
  dispatch: [dispatch('ZZ-1'), dispatch('ZZ-4')],
  refusals: [
    refusal('ZZ-2', 'needs-grant', 'needs grant: deploy'),
    refusal('ZZ-5', 'role-cap', 'seat s holds 2 of 2 implementers'),
  ],
}

const verdictLine = (lines: string[], id: string) => lines.find(line => line.includes(` ${id} `))

describe('seats compare verdicts', () => {
  it('passes when every score.py ID is dispatched in order, refused, held or beyond caps', () => {
    const result = compareSeat(input(explained, { held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-1')).toContain('dispatched as pick 1')
    expect(verdictLine(result.lines, 'ZZ-2')).toContain('refused [needs-grant]: needs grant: deploy')
    expect(verdictLine(result.lines, 'ZZ-3')).toContain('held')
    expect(verdictLine(result.lines, 'ZZ-4')).toContain('dispatched as pick 2')
    expect(verdictLine(result.lines, 'ZZ-5')).toContain('beyond caps [role-cap]')
    expect(result.lines.at(-1)).toBe(
      'PASS: 5 score.py IDs; 2 dispatched, 1 refused, 1 held, 1 beyond caps, 0 unexplained',
    )
  })

  it('prints raw and decayed scores for each ID', () => {
    const result = compareSeat(input(explained, { held: new Set(['ZZ-3']) }))

    expect(verdictLine(result.lines, 'ZZ-3')).toContain('ZZ-3 beta score 70 effective 70')
  })

  it('reports an intangible-held ID as held, not as an unexplained skip', () => {
    const plan = { ...explained, placement: placed({}, { intangibleHeld: ['ZZ-3'] }) }
    const result = compareSeat(input(plan))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-3')).toContain('held [intangible]')
    expect(result.lines.at(-1)).toBe(
      'PASS: 5 score.py IDs; 2 dispatched, 1 refused, 1 held, 1 beyond caps, 0 unexplained',
    )
  })

  it('fails on an ID the plan neither dispatched nor refused', () => {
    const result = compareSeat(input(explained))

    expect(result.ok).toBe(false)
    expect(verdictLine(result.lines, 'ZZ-3')).toContain('UNEXPLAINED SKIP')
    expect(result.lines.at(-1)).toMatch(/^FAIL: .* 1 unexplained$/)
  })

  it('explains a silent ID by the plan share-cap count for its kind', () => {
    const plan = { ...explained, shareCapped: { 'share-cap:feature': 1 } as const }
    const result = compareSeat(input(plan))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-3')).toContain('beyond caps [share-cap:feature]')
  })
})

describe('seats compare order', () => {
  const reordered = {
    dispatch: [dispatch('ZZ-4'), dispatch('ZZ-1')],
    refusals: [refusal('ZZ-2', 'not-open', 'x'), refusal('ZZ-5', 'budget', 'pool closed')],
  }

  it('fails a dispatch that overtakes a higher-ranked dispatch with no recorded reason', () => {
    const result = compareSeat(input(reordered, { held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(false)
    expect(verdictLine(result.lines, 'ZZ-4')).toContain(
      'OUT OF ORDER: dispatched as pick 1, ahead of #1 ZZ-1 with no recorded reason',
    )
  })

  it('explains a jump that planOrder records as a higher milestone tier, and prints the reason', () => {
    const placement = placed({ 'ZZ-4': { tier: 2, milestone: 'M-1', float: 0 }, 'ZZ-1': { tier: 3 } })
    const result = compareSeat(input({ ...reordered, placement }, { held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-4')).toContain(
      'ahead of #1 ZZ-1: tier 2 (milestone M-1, float 0) over tier 3 (standard)',
    )
  })

  it('accepts any order within tier 1, as the plan sorts it by slack and age', () => {
    const placement = placed({ 'ZZ-4': { tier: 1, slack: 1 }, 'ZZ-1': { tier: 1, slack: 0 } })
    const result = compareSeat(input({ ...reordered, placement }, { held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-4')).toContain('same tier 1 (fixed date)')
  })

  it('still fails a jump within the standard tier, which follows score.py order', () => {
    const placement = placed({ 'ZZ-4': { tier: 3 }, 'ZZ-1': { tier: 3 } })
    const result = compareSeat(input({ ...reordered, placement }, { held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(false)
    expect(verdictLine(result.lines, 'ZZ-4')).toContain('OUT OF ORDER')
  })

  const betaFirst = parseScorePy(
    JSON.stringify({
      order: [
        scoreRow('ZZ-1', 90, { initiative: 'beta' }),
        scoreRow('ZZ-3', 70, { initiative: 'beta' }),
        scoreRow('ZZ-4', 60),
      ],
    }),
  )
  const betaDecayed = { 'ZZ-1': { tier: 3 }, 'ZZ-3': { tier: 0 }, 'ZZ-4': { tier: 3 } } as const
  const decayedBy = (id: string) => ({ decaying: [{ id, initiative: 'beta', tier: 0 }] })

  it('explains a standard jump by a dispatched tier 0 row that decays the overtaken initiative in the plan only', () => {
    const plan = {
      dispatch: [
        dispatch('ZZ-3', { initiative: 'beta' }),
        dispatch('ZZ-4'),
        dispatch('ZZ-1', { initiative: 'beta' }),
      ],
      placement: placed(betaDecayed, decayedBy('ZZ-3')),
    }
    const result = compareSeat(input(plan, { score: betaFirst }))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-4')).toContain('tier 0 row ZZ-3 decays beta in the plan only')
  })

  it('explains the same jump when the ledger holds the tier 0 row, as planOrder decays it dispatched or not', () => {
    const plan = {
      dispatch: [dispatch('ZZ-4'), dispatch('ZZ-1', { initiative: 'beta' })],
      placement: placed(betaDecayed, decayedBy('ZZ-3')),
    }
    const result = compareSeat(input(plan, { score: betaFirst, held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-4')).toContain('tier 0 row ZZ-3 decays beta in the plan only')
  })

  it('still fails a lower tier dispatched ahead of a higher one with no reason', () => {
    const placement = placed({ 'ZZ-4': { tier: 3 }, 'ZZ-1': { tier: 2 } }, { decaying: [] })

    expect(compareSeat(input({ ...reordered, placement }, { held: new Set(['ZZ-3']) })).ok).toBe(false)
  })

  it('fails a reorder when the plan recorded no placement, as compare infers none', () => {
    const tiered = { ...reordered, dispatch: [dispatch('ZZ-4', { tier: 1 }), dispatch('ZZ-1', { tier: 3 })] }

    expect(compareSeat(input(tiered, { held: new Set(['ZZ-3']) })).ok).toBe(false)
  })

  it('keeps a share-cap reorder explained', () => {
    const plan = {
      dispatch: [dispatch('ZZ-4'), dispatch('ZZ-1')],
      refusals: [refusal('ZZ-2', 'not-open', 'x'), refusal('ZZ-5', 'budget', 'pool closed')],
      placement: placed({ 'ZZ-4': { tier: 3 }, 'ZZ-1': { tier: 3 } }),
      shareCapped: { 'share-cap:feature': 1 } as const,
    }
    const score = parseScorePy(
      JSON.stringify({
        order: [
          scoreRow('ZZ-1', 90),
          scoreRow('ZZ-3', 85),
          scoreRow('ZZ-2', 80),
          scoreRow('ZZ-4', 60),
          scoreRow('ZZ-5', 50),
        ],
      }),
    )
    const result = compareSeat(input(plan, { score }))

    expect(result.ok).toBe(true)
    expect(verdictLine(result.lines, 'ZZ-3')).toContain('beyond caps [share-cap:feature]')
  })

  it('fails a dispatch score.py does not list and names the landed commit', () => {
    const score = parseScorePy(SCORE_PY_STDOUT, 'LANDED ZZ-9: /tmp/repo: abc123 ZZ-9: Add widget\n')
    const plan = { ...explained, dispatch: [...explained.dispatch, dispatch('ZZ-9')] }
    const result = compareSeat(input(plan, { score, held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(false)
    expect(result.lines).toContain(
      "EXTRA DISPATCH ZZ-9: not in score.py's order; score.py found it landed (/tmp/repo: abc123 ZZ-9: Add widget)",
    )
  })

  it('leaves ready-slice dispatches out of the order check', () => {
    const plan = { ...explained, dispatch: [dispatch('ZZ-8', { slice: 's1' }), ...explained.dispatch] }
    const result = compareSeat(input(plan, { held: new Set(['ZZ-3']) }))

    expect(result.ok).toBe(true)
    expect(result.lines).toContain("ready slices dispatched outside score.py's order: 1")
  })
})

describe('running score.py', () => {
  it('passes the plan prior picks and the pinned day', () => {
    expect(scorePyArgs('seat-a', '2026-10-05', { alpha: 2 })).toEqual([
      '--seat',
      'seat-a',
      '--check-landed',
      '--json',
      '--top',
      '1000',
      '--today',
      '2026-10-05',
      '--prior',
      'alpha=2',
    ])
  })

  it('runs score.py from the autonomy root and parses its order', () => {
    const calls: string[][] = []
    const runner = (bin: string, args: string[]): RunResult => {
      calls.push([bin, ...args])
      return { status: 0, stdout: SCORE_PY_STDOUT, stderr: '' }
    }

    const out = runScorePy('/tmp/autonomy', ['--seat', 'seat-a'], runner)

    expect(calls).toEqual([['python3', '/tmp/autonomy/score.py', '--seat', 'seat-a']])
    expect(out.order.map(r => r.id)).toEqual(['ZZ-1', 'ZZ-2', 'ZZ-3', 'ZZ-4', 'ZZ-5'])
  })

  it('says python3 is missing when score.py never ran', () => {
    const runner = (): RunResult => ({ status: null, stdout: '', stderr: '' })

    expect(() => runScorePy('/tmp/autonomy', [], runner)).toThrow('python3 is missing')
  })

  it('throws with the last stderr line when score.py fails', () => {
    const runner = (): RunResult => ({ status: 1, stdout: '', stderr: 'Traceback\nKeyError: seat-z\n' })

    expect(() => runScorePy('/tmp/autonomy', [], runner)).toThrow('score.py exited 1: KeyError: seat-z')
  })
})
