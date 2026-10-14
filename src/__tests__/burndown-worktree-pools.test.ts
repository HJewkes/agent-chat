import { describe, expect, it } from 'vitest'
import { binaryGate } from '../agents/burndown/gate-reading.js'
import { worktreeUse } from '../agents/burndown/observe.js'
import { capacityRefusal, type Capacity, type Tally } from '../agents/burndown/plan.js'

const config = { maxWorktreesPerRepo: 6, reserveWorktrees: 2 }
const REPO = '/tmp/repos/alpha'
const reviewerTrees = Array.from({ length: 8 }, (_, i) => `rv-a-b-${i + 1}`)

function capacityOver(names: string[] | undefined): Capacity {
  return {
    agents: 5,
    agentsReason: 'free',
    agentsGate: () => binaryGate('agentSlots', 'test'),
    worktrees: () => worktreeUse(names, 12, config),
  }
}

const emptyTally = (): Tally => ({ agents: 0, worktrees: new Map() })

describe('burndown worktree pools (CC-1040)', () => {
  it('eight reviewer trees do not block an implementer dispatch', () => {
    const names = [...reviewerTrees, 'bd-x']

    const use = worktreeUse(names, 12, config)
    const refusal = capacityRefusal(
      { repo: REPO, worktree: `${REPO}/.worktrees/bd-new` },
      capacityOver(names),
      emptyTally(),
    )

    expect(use).toMatchObject({ total: 1, reviewers: 8 })
    expect(refusal).toBeUndefined()
  })

  it('counts a -reviewer tree in the reviewer pool and a previewer tree as an implementer', () => {
    expect(worktreeUse(['seat-a-reviewer', 'previewer-x'], 12, config)).toMatchObject({
      total: 1,
      reviewers: 1,
    })
  })

  it('a full implementer pool names it', () => {
    const names = [...Array.from({ length: 10 }, (_, i) => `impl-${i}`), 'rv-a-b-1']

    const refusal = capacityRefusal(
      { repo: REPO, worktree: `${REPO}/.worktrees/bd-new` },
      capacityOver(names),
      emptyTally(),
    )

    expect(refusal?.kind).toBe('worktrees')
    expect(refusal?.reason).toContain('implementer pool full')
    expect(refusal?.reason).toContain('1 reviewer trees not counted')
    expect(refusal?.reason).toContain('the tick stops at 10')
  })

  it('an unreadable repo is still full', () => {
    const use = worktreeUse(undefined, 12, config)

    expect(use.total).toBe(use.totalCeiling)
  })
})
