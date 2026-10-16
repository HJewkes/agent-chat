import { describe, expect, it } from 'vitest'
import { collision, type CollisionFacts, type CollisionWork } from '../agents/burndown/collision.js'

/** CC-1158 c: a stacked child's own parent PR is exempt from file-overlap; every other PR still checks. */

const PARENT = { taskId: 'ZZ-1', slice: 'a', pr: 'example/repo#40', branch: 'agent-chat/parent' }

const child = (over: Partial<CollisionWork> = {}): CollisionWork => ({
  taskId: 'ZZ-1',
  slice: 'b',
  tags: [],
  owns: ['src/shared/widget.ts'],
  stackedOn: PARENT,
  ...over,
})

const unstacked = (): CollisionWork => {
  const { stackedOn: _parent, ...rest } = child()
  return rest
}

const facts = (prFiles: Record<number, string[]>): CollisionFacts => ({
  repo: '/repo',
  subjects: [],
  prs: Object.keys(prFiles).map(n => ({
    number: Number(n),
    title: 'Change',
    branch: `feat/x-${n}`,
    body: '',
  })),
  prFiles: n => prFiles[n],
  names: [],
  claims: [],
  ours: new Set(),
  held: [],
  heldOwns: [],
})

describe('file-overlap for a stacked child', () => {
  it('does not refuse a child overlapping its parent PR', () => {
    expect(collision(child(), facts({ 40: ['src/shared/widget.ts'] }))).toBeUndefined()
  })

  it('still refuses the same file in an unrelated PR', () => {
    const found = collision(child(), facts({ 40: ['src/shared/widget.ts'], 41: ['src/shared/widget.ts'] }))
    expect(found).toEqual({ kind: 'file-overlap', reason: '#41 touches src/shared/widget.ts', pr: 41 })
  })

  it('refuses a child that is not stacked even when a PR is numbered like a parent', () => {
    const found = collision(unstacked(), facts({ 40: ['src/shared/widget.ts'] }))
    expect(found?.kind).toBe('file-overlap')
  })

  it('exempts only the parent PR number, not one sharing a digit prefix', () => {
    const found = collision(child(), facts({ 400: ['src/shared/widget.ts'] }))
    expect(found?.reason).toBe('#400 touches src/shared/widget.ts')
  })

  it('reads no file list for the exempt parent PR', () => {
    const read: number[] = []
    const f = { ...facts({ 40: [], 41: [] }), prFiles: (n: number) => (read.push(n), []) }
    collision(child(), f)
    expect(read).toEqual([41])
  })
})
