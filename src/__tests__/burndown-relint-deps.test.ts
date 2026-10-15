import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readLedger,
  readySlices,
  writeLedger,
  type Claim,
  type Ledger,
  type Phase,
} from '../agents/burndown/ledger.js'
import {
  applyApproved,
  falseEdges,
  type ApprovedEdge,
  type PlanOf,
} from '../agents/burndown/relint-queued.js'
import { relintDepsApply, relintDepsLines } from '../cli/verbs/burndown.js'

/** CC-1156: CC-1155's disjoint-owns edge lint over slices already queued in the ledger. */

const AT = '2026-10-14T12:00:00.000Z'
const PLAN = '/tmp/aw/alpha/sources/A-1-plan.md'

interface SliceSpec {
  n: string
  owns: string[]
  dependsOn?: string[]
  dependsWhy?: string
}

function planText(slices: SliceSpec[]): string {
  const block = slices.map(s => ({
    n: s.n,
    title: `slice ${s.n}`,
    points: 1,
    doneWhen: 'Its test passes.',
    dependsOn: s.dependsOn ?? [],
    owns: s.owns,
    ...(s.dependsWhy === undefined ? {} : { dependsWhy: s.dependsWhy }),
  }))
  return `# plan\n\n\`\`\`burndown-slices\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`
}

function claim(spec: SliceSpec, extra: Partial<Claim> = {}): Claim {
  return {
    taskId: 'A-1',
    initiative: 'alpha',
    spawnedAt: AT,
    phase: 'queued',
    phaseAt: AT,
    slice: spec.n,
    dependsOn: spec.dependsOn ?? [],
    owns: spec.owns,
    ...extra,
  }
}

function fixture(slices: SliceSpec[], extra: Record<string, Partial<Claim>> = {}): [Ledger, PlanOf] {
  const parentPhase: Partial<Claim> = { phase: 'implementing' as Phase }
  const claims = slices.map(s => claim(s, s.n === 'a' ? { ...parentPhase, ...extra[s.n] } : extra[s.n]))
  const text = planText(slices)
  return [{ version: 1, claims }, () => ({ path: PLAN, text })]
}

const A: SliceSpec = { n: 'a', owns: ['src/ledger.ts'] }
const B: SliceSpec = { n: 'b', owns: ['src/tick.ts'], dependsOn: ['a'] }

describe('burndown relint-deps dry run', () => {
  it('lists a queued slice whose edge links disjoint owns with no dependsWhy, with its plan path', () => {
    const [ledger, planOf] = fixture([A, B])

    const edges = falseEdges(ledger, planOf)

    expect(edges).toEqual([
      {
        taskId: 'A-1',
        initiative: 'alpha',
        slice: 'b',
        dep: 'a',
        plan: PLAN,
        owns: ['src/tick.ts'],
        depOwns: ['src/ledger.ts'],
      },
    ])
  })

  it('keeps an edge whose owns overlap', () => {
    const [ledger, planOf] = fixture([A, { ...B, owns: ['src/tick.ts', 'src/ledger.ts'] }])

    expect(falseEdges(ledger, planOf)).toEqual([])
  })

  it('keeps an edge whose slice says why in the current plan', () => {
    const [ledger, planOf] = fixture([A, { ...B, dependsWhy: 'b imports the type a adds' }])

    expect(falseEdges(ledger, planOf)).toEqual([])
  })

  it.each<Phase>(['spawning', 'implementing', 'awaiting-merge'])('keeps the edge of a %s slice', phase => {
    const [ledger, planOf] = fixture([A, B], { b: { phase } })

    expect(falseEdges(ledger, planOf)).toEqual([])
  })

  it('keeps the edge of a queued slice stacked on its parent', () => {
    const stackedOn = { taskId: 'A-1', slice: 'a', pr: '12', branch: 'feat/a' }
    const [ledger, planOf] = fixture([A, B], { b: { stackedOn } })

    expect(falseEdges(ledger, planOf)).toEqual([])
  })

  it('keeps every edge when the plan is missing, since dependsWhy cannot be read', () => {
    const [ledger] = fixture([A, B])

    expect(falseEdges(ledger, () => ({ path: PLAN, text: undefined }))).toEqual([])
  })

  it("narrows to one seat's claims", () => {
    const [ledger, planOf] = fixture([A, B], { b: { seat: 'seat-a' } })

    expect(falseEdges(ledger, planOf, 'seat-b')).toEqual([])
    expect(falseEdges(ledger, planOf, 'seat-a')).toHaveLength(1)
  })

  it('prints one line per edge with its plan path, then the count', () => {
    const [ledger, planOf] = fixture([A, B])

    const report = relintDepsLines(ledger, planOf, undefined, false)

    expect(report.lines).toEqual([
      `A-1 b -> a  owns src/tick.ts  dep owns src/ledger.ts  plan ${PLAN}`,
      '1 queued dependsOn edge(s) over disjoint owns with no dependsWhy',
    ])
  })
})

describe('burndown relint-deps --apply', () => {
  const C: SliceSpec = { n: 'c', owns: ['src/report.ts'], dependsOn: ['a'] }
  const D: SliceSpec = { n: 'd', owns: ['src/seat.ts'], dependsOn: ['a'] }
  const E: SliceSpec = { n: 'e', owns: ['src/cli.ts'], dependsOn: ['a'] }
  const edge = (slice: string): ApprovedEdge => ({ taskId: 'A-1', slice, dep: 'a' })

  let dir: string
  let ledgerFile: string
  let approvedFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relint-apply-'))
    ledgerFile = path.join(dir, 'burndown.json')
    approvedFile = path.join(dir, 'approved.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const dependsOf = (ledger: Ledger, slice: string): string[] | undefined =>
    ledger.claims.find(c => c.slice === slice)?.dependsOn

  it('clears only the approved edges of three listed, and those slices become ready', async () => {
    const [ledger, planOf] = fixture([A, B, C, D])
    writeLedger(ledgerFile, ledger)
    fs.writeFileSync(approvedFile, JSON.stringify(falseEdges(ledger, planOf).filter(e => e.slice !== 'd')))
    const journaled: ApprovedEdge[] = []

    const report = await relintDepsApply(ledgerFile, approvedFile, planOf, e => journaled.push(e))

    const after = readLedger(ledgerFile)
    expect([dependsOf(after, 'b'), dependsOf(after, 'c'), dependsOf(after, 'd')]).toEqual([[], [], ['a']])
    expect(readySlices(after).map(c => c.slice)).toEqual(['b', 'c'])
    expect(journaled).toEqual([edge('b'), edge('c')])
    expect(report.lines.at(-1)).toBe('2 edge(s) cleared, 0 skipped')
  })

  it('skips and reports an approved edge whose slice was claimed after the dry run', async () => {
    const [ledger, planOf] = fixture([A, B, E], { e: { phase: 'implementing' } })
    writeLedger(ledgerFile, ledger)
    fs.writeFileSync(approvedFile, JSON.stringify([edge('b'), edge('e')]))
    const journaled: ApprovedEdge[] = []

    const report = await relintDepsApply(ledgerFile, approvedFile, planOf, e => journaled.push(e))

    expect(dependsOf(readLedger(ledgerFile), 'e')).toEqual(['a'])
    expect(journaled).toEqual([edge('b')])
    expect(report.lines).toContain('skipped A-1 e -> a: slice is implementing')
  })

  it('skips an approved edge whose slice gained a dependsWhy since the dry run', () => {
    const [ledger, planOf] = fixture([A, { ...B, dependsWhy: 'b reads the column a adds' }])

    const result = applyApproved(ledger, [edge('b')], planOf)

    expect(result.cleared).toEqual([])
    expect(result.skipped[0]?.reason).toMatch(/dependsWhy/)
    expect(dependsOf(result.ledger, 'b')).toEqual(['a'])
  })

  it('skips an approved edge whose slice was stacked since the dry run', () => {
    const stackedOn = { taskId: 'A-1', slice: 'a', pr: '12', branch: 'feat/a' }
    const [ledger, planOf] = fixture([A, B], { b: { stackedOn } })

    const result = applyApproved(ledger, [edge('b')], planOf)

    expect(result.skipped).toEqual([{ edge: edge('b'), reason: 'slice is stacked' }])
    expect(dependsOf(result.ledger, 'b')).toEqual(['a'])
  })

  it('leaves the ledger file untouched when nothing is approved', async () => {
    const [ledger, planOf] = fixture([A, B])
    writeLedger(ledgerFile, ledger)
    const before = fs.readFileSync(ledgerFile, 'utf8')
    fs.writeFileSync(approvedFile, '[]')

    const report = await relintDepsApply(ledgerFile, approvedFile, planOf, () => undefined)

    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(before)
    expect(report.lines).toEqual(['0 edge(s) cleared, 0 skipped'])
  })
})
