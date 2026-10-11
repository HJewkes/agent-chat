import { describe, expect, it } from 'vitest'
import type { SweptWorktree } from '../agents/isolation/sweep.js'
import {
  lowDiskWarning,
  nonSeatRow,
  repoHeadroom,
  repoSummary,
  rowState,
  stateRow,
  volumeFreeBytes,
} from '../agents/isolation/worktree-states.js'

/** CC-284: the state words and the one headroom line a seat quotes instead of hand-counting. */

const GB = 1024 ** 3

const swept = (status: SweptWorktree['status'], branch = 'agent-chat/impl-1'): SweptWorktree => ({
  gitRoot: '/repo',
  worktree: `/repo/.worktrees/${branch.slice('agent-chat/'.length)}`,
  branch,
  status,
  detail: 'why',
})

describe('worktree row state', () => {
  it.each([
    ['held', 'active'],
    ['in-grace', 'active'],
    ['reclaimable', 'parkable'],
    ['holds-work', 'stale'],
  ] as const)('a %s tree is %s', (status, state) => {
    expect(rowState(swept(status))).toBe(state)
  })

  it('an exited reviewer tree is reviewer-scratch whether or not it holds work', () => {
    expect(rowState(swept('reclaimable', 'agent-chat/rv-pr-12'))).toBe('reviewer-scratch')
    expect(rowState(swept('holds-work', 'agent-chat/rv-pr-12'))).toBe('reviewer-scratch')
  })

  it('a live reviewer still counts as active', () => {
    expect(rowState(swept('held', 'agent-chat/rv-pr-12'))).toBe('active')
  })

  it('a tree on any other branch is non-seat', () => {
    expect(nonSeatRow({ path: '/repo/.claude/worktrees/x', branch: 'feat/x' }).state).toBe('non-seat')
  })
})

describe('repo headroom line', () => {
  const rows = [
    ...['held', 'in-grace'].map((s, i) => stateRow(swept(s as 'held', `agent-chat/a${i}`))),
    ...[0, 1, 2].map(i => stateRow(swept('reclaimable', `agent-chat/p${i}`))),
    stateRow(swept('holds-work', 'agent-chat/old')),
    nonSeatRow({ path: '/repo/.claude/worktrees/x', branch: 'feat/x' }),
  ]

  it('prints active, parkable, non-seat, budget and free slots', () => {
    expect(repoSummary(repoHeadroom('/repo', rows, 12, 100 * GB))).toBe(
      '/repo: active 2, parkable 3, non-seat 1, budget 12, free 9',
    )
  })

  it('never reports negative free slots', () => {
    expect(repoHeadroom('/repo', rows, 2, 100 * GB).free).toBe(0)
  })

  it('carries the same numbers in its JSON form as in the line', () => {
    const parsed = JSON.parse(JSON.stringify(repoHeadroom('/repo', rows, 12, 100 * GB)))
    expect(parsed).toMatchObject({
      gitRoot: '/repo',
      active: 2,
      parkable: 3,
      nonSeat: 1,
      budget: 12,
      free: 9,
    })
    expect(parsed.rows).toHaveLength(rows.length)
    expect(parsed.rows[0]).toMatchObject({ state: 'active', branch: 'agent-chat/a0', status: 'held' })
  })
})

describe('low-disk warning', () => {
  it('warns under 50 GB free', () => {
    expect(lowDiskWarning('/repo', 49 * GB)).toBe(
      'warning: 49.0 GB free on the volume holding /repo, under 50 GB',
    )
  })

  it('stays quiet at 51 GB free', () => {
    expect(lowDiskWarning('/repo', 51 * GB)).toBeUndefined()
  })

  it('reads free space as unknown, and stays quiet, for a repo that no longer exists', () => {
    const free = volumeFreeBytes('/nonexistent/cc-284/deleted-clone')
    expect(free).toBeNull()
    expect(lowDiskWarning('/nonexistent/cc-284/deleted-clone', free)).toBeUndefined()
  })
})
