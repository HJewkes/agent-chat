import { describe, expect, it } from 'vitest'
import { isolationFor, floorWarning } from '../agents/supervisor.js'
import { fileOwnershipStrategy } from '../agents/isolation/index.js'
import type { IsolationContext } from '../agents/isolation/index.js'

/**
 * CC-72/CC-81: the task system's assignment decides isolation, not the profile.
 *
 * "Isolation is a property of the WORK, not of the agent" (decision, 2026-08-11).
 * The profile only ever guessed, so an assignment outranks it — and outranks an
 * explicit `isolation` argument too, which says what strategy to run rather than
 * what the work needs.
 */
describe('isolationFor', () => {
  const profile = { isolation: 'none' } as const

  it('takes worktree isolation from an assigned worktree, over the profile', () => {
    expect(isolationFor({ worktree: '/wt' }, profile)).toBe('worktree')
  })

  it('takes file-ownership from declared paths', () => {
    expect(isolationFor({ owns: ['src/**'] }, profile)).toBe('file-ownership')
  })

  it('lets an assigned worktree win over declared paths, since paths live inside one', () => {
    expect(isolationFor({ worktree: '/wt', owns: ['src/**'] }, profile)).toBe('worktree')
  })

  it('outranks an explicit isolation argument', () => {
    expect(isolationFor({ worktree: '/wt', isolation: 'none' }, profile)).toBe('worktree')
    expect(isolationFor({ owns: ['src/**'], isolation: 'none' }, profile)).toBe('file-ownership')
  })

  it('falls back to the request, then the profile, when nothing was assigned', () => {
    expect(isolationFor({ isolation: 'toolset-limited' }, profile)).toBe('toolset-limited')
    expect(isolationFor({}, { isolation: 'worktree' })).toBe('worktree')
  })

  it('ignores an empty owns list rather than reading it as an assignment', () => {
    // `owns: []` has two plausible readings — owns nothing, owns everything — so
    // it means neither and the profile decides, matching optionalPatterns.
    expect(isolationFor({ owns: [] }, { isolation: 'worktree' })).toBe('worktree')
  })
})

describe('the isolation floor', () => {
  it('warns when a request drops a profile out of its own worktree', () => {
    expect(floorWarning('none', 'worktree')).toMatch(/widens/)
  })

  it('says nothing when the profile did not ask for a worktree', () => {
    expect(floorWarning('none', 'none')).toBeUndefined()
    expect(floorWarning('file-ownership', 'toolset-limited')).toBeUndefined()
  })

  it('says nothing when the worktree is kept', () => {
    expect(floorWarning('worktree', 'worktree')).toBeUndefined()
  })

  it('warns rather than refuses, so a deliberate override still spawns', () => {
    // A throwaway probe that must not hold a worktree slot is a real use. The
    // warning is the whole mechanism; a refusal would leave no way through.
    expect(typeof floorWarning('none', 'worktree')).toBe('string')
  })
})

/**
 * The regression that matters most here: `file-ownership` was INERT. Nothing
 * populated `declaredPaths` and nothing populated `peers`, so it allocated
 * against an empty roster and silently behaved like `none`. These pin both
 * halves — a conflict it must see, and a disjoint split it must allow.
 */
describe('file-ownership, once its inputs are actually supplied', () => {
  const ctx = (over: Partial<IsolationContext>): IsolationContext => ({
    agentId: 'ag-2',
    agentName: 'bob',
    baseCwd: '/repo',
    ...over,
  })

  it('names the peer holding an overlapping path', async () => {
    const found = await fileOwnershipStrategy.check(
      ctx({
        declaredPaths: ['src/broker/socket.ts'],
        peers: [{ agentId: 'ag-1', name: 'alice', cwd: '/repo', claims: ['src/broker/**'] }],
      }),
    )
    expect(found.join(' ')).toContain('alice')
  })

  it('allows a disjoint split, which is the point of sharing a worktree', async () => {
    const found = await fileOwnershipStrategy.check(
      ctx({
        declaredPaths: ['src/cli/**'],
        peers: [{ agentId: 'ag-1', name: 'alice', cwd: '/repo', claims: ['src/broker/**'] }],
      }),
    )
    expect(found).toEqual([])
  })

  it('sees nothing when peers are absent — the state that made it a no-op', async () => {
    // Kept as a control: this passing while the first case FAILS is exactly the
    // bug, so the two together distinguish "wired" from "silently empty".
    expect(await fileOwnershipStrategy.check(ctx({ declaredPaths: ['src/broker/**'] }))).toEqual([])
  })

  it('refuses under strict, warns otherwise', async () => {
    const over = {
      declaredPaths: ['src/broker/socket.ts'],
      peers: [{ agentId: 'ag-1', name: 'alice', cwd: '/repo', claims: ['src/broker/**'] }],
    }
    const warned = await fileOwnershipStrategy.check(ctx(over))
    const refused = await fileOwnershipStrategy.check(ctx({ ...over, strict: true }))
    expect(warned).not.toEqual(refused)
  })

  it('ignores a peer in a different worktree — two trees are two branches', async () => {
    const found = await fileOwnershipStrategy.check(
      ctx({
        declaredPaths: ['src/broker/**'],
        peers: [{ agentId: 'ag-1', name: 'alice', cwd: '/other', claims: ['src/broker/**'] }],
      }),
    )
    expect(found).toEqual([])
  })
})
