import { describe, expect, it } from 'vitest'
import { parseSeat } from '../agents/burndown/policy.js'
import { matchesCountedTree, parseWorktreeList, seatTrees } from '../agents/seats/trees.js'
import type { AgentIdentity } from '../protocol.js'

const PORCELAIN = `worktree /repo
HEAD aaaa
branch refs/heads/main

worktree /repo/.worktrees/feat-x
HEAD bbbb
branch refs/heads/feat/x

worktree /repo/.worktrees/bare-one
bare

worktree /repo/.worktrees/stale
HEAD cccc
branch refs/heads/stale
prunable gitdir file points to non-existent location

worktree /repo/.worktrees/ev-r1-c2
HEAD dddd
detached
`

const agent = (name: string, cwd: string): AgentIdentity =>
  ({ name, cwd, isolation: 'worktree', state: 'exited', profile: 'reviewer' }) as unknown as AgentIdentity

describe('seat trees', () => {
  it('parses every linked tree with its branch and skips the main, bare and prunable ones', () => {
    const trees = parseWorktreeList(PORCELAIN)

    expect(trees.map(t => t.path)).toEqual(['/repo/.worktrees/feat-x', '/repo/.worktrees/ev-r1-c2'])
    expect(trees[0]?.branch).toBe('feat/x')
  })

  it('a detached-HEAD linked tree parses with no branch and still matches on its basename', () => {
    const detached = parseWorktreeList(PORCELAIN)[1]

    expect(detached?.branch).toBeUndefined()
    expect(matchesCountedTree('ev-*', detached?.branch, 'ev-r1-c2')).toBe(true)
  })

  it('eval/* matches eval/run/case/token but not evaluation/x or feat/eval/x', () => {
    expect(matchesCountedTree('eval/*', 'eval/run/case/token', 'tok')).toBe(true)
    expect(matchesCountedTree('eval/*', 'evaluation/x', 'x')).toBe(false)
    expect(matchesCountedTree('eval/*', 'feat/eval/x', 'x')).toBe(false)
  })

  it('a seat file without counted_trees parses to an empty list, and a non-string entry is rejected', () => {
    expect(parseSeat('---\nconcurrency: {implementers: 1}\n---\n', 's').concurrency.counted_trees).toEqual([])
    expect(() => parseSeat('---\nconcurrency: {counted_trees: [3]}\n---\n', 's')).toThrow()
  })

  it('counts an agent tree and a pattern tree at the same canonical path once, agent first', () => {
    const real = (p: string) => p.replace('/link/', '/repo/')
    const result = seatTrees({
      agents: [agent('rv-1', '/link/.worktrees/ev-r1-c2')],
      repoTrees: [PORCELAIN],
      patterns: ['ev-*'],
      realpath: real,
      exists: () => true,
    })

    expect(result).toEqual([{ path: '/repo/.worktrees/ev-r1-c2', cause: 'agent', agent: 'rv-1' }])
  })
})
