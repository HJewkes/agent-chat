import { describe, expect, it } from 'vitest'
import { applyActions } from '../agents/burndown/advance.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { resyncQueuedSlices, type PlanReader } from '../agents/burndown/seed-slices.js'

/** CC-1231: a plan whose slice set drifted from the ledger is applied by the tick where it is safe. */

const NOW = new Date('2026-10-13T12:00:00.000Z')
const PLAN_PATH = '/tmp/aw/demo/sources/DM-1-plan.md'

const slice = (n: string, owns: string[] = [`${n}.ts`], dependsOn: string[] = []) => ({
  n,
  title: `slice ${n}`,
  dependsOn,
  owns,
  points: 1,
  doneWhen: `Slice ${n} test passes.`,
})

const planText = (slices: readonly object[]): string =>
  `# DM-1 plan\n\n\`\`\`burndown-slices\n${JSON.stringify(slices, null, 2)}\n\`\`\`\n`

const claim = (n: string, extra: Partial<Claim> = {}): Claim => ({
  taskId: 'DM-1',
  initiative: 'demo',
  spawnedAt: NOW.toISOString(),
  phase: 'queued',
  phaseAt: NOW.toISOString(),
  slice: n,
  dependsOn: [],
  owns: [`${n}.ts`],
  seat: 'seat-x',
  ...extra,
})

const ledgerOf = (claims: Claim[]): Ledger => ({ version: 1, claims })
const reader =
  (slices: readonly object[]): PlanReader =>
  () => ({ path: PLAN_PATH, text: planText(slices) })

const resync = (claims: Claim[], slices: readonly object[]) => {
  const ledger = ledgerOf(claims)
  const out = resyncQueuedSlices(ledger, reader(slices), NOW)
  return { out, after: applyActions(ledger, out.actions, NOW) }
}

describe('plan drift the tick applies', () => {
  it('queues a claim for a plan slice that has none, keeping the seat', () => {
    const { out, after } = resync([claim('a')], [slice('a'), slice('b')])

    const added = after.claims.find(c => c.slice === 'b')
    expect(added).toMatchObject({ phase: 'queued', owns: ['b.ts'], seat: 'seat-x', taskId: 'DM-1' })
    expect(out.notes.join('\n')).not.toContain('to reseed')
  })

  it('drops a queued claim with no agent and no PR for a slice the plan removed', () => {
    const { out, after } = resync([claim('a'), claim('b')], [slice('a')])

    expect(after.claims.find(c => c.slice === 'b')?.phase).toBe('done')
    expect(after.claims.find(c => c.slice === 'a')?.phase).toBe('queued')
    expect(out.notes.join('\n')).not.toContain('to reseed')
  })

  it('reaches a stable state: a second pass over the result has nothing to do', () => {
    const { after } = resync([claim('a'), claim('b')], [slice('a'), slice('c')])

    const again = resyncQueuedSlices(after, reader([slice('a'), slice('c')]), NOW)

    expect(again).toEqual({ actions: [], notes: [] })
  })

  it('never touches a removed slice that has an agent, a PR or is done, and names the live one', () => {
    const claims = [
      claim('a'),
      claim('b', { phase: 'running', agentName: 'dm-1-b' }),
      claim('c', { phase: 'queued', pr: 12 }),
      claim('d', { phase: 'done' }),
    ]

    const { out, after } = resync(claims, [slice('a')])

    expect(after.claims).toEqual(claims)
    expect(out.actions).toEqual([])
    expect(out.notes).toHaveLength(2)
    expect(out.notes[0]).toContain('slice b')
    expect(out.notes[1]).toContain('slice c')
  })

  it('never queues over a slice that already has a done claim', () => {
    const { out } = resync([claim('a'), claim('b', { phase: 'done' })], [slice('a'), slice('b')])

    expect(out).toEqual({ actions: [], notes: [] })
  })

  it('applies the add and keeps the note for a live slice the plan removed', () => {
    const { out, after } = resync([claim('a', { phase: 'running', agentName: 'dm-1-a' })], [slice('b')])

    expect(after.claims.map(c => c.slice)).toEqual(['a', 'b'])
    expect(out.notes.some(n => n.includes('slice a') && n.includes('to reseed'))).toBe(true)
  })
})
