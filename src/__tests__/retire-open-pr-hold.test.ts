import { describe, expect, it, vi } from 'vitest'
import type { AgentEventRow } from '../broker/event-store.js'
import {
  heldBranches,
  memoizeOpenPr,
  openPrHold,
  reviewedAgentName,
  type OpenPrRead,
} from '../agents/isolation/open-pr-hold.js'
import { allocatedWorktree } from '../agents/isolation/park.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1325: the bulk finished retire keeps implementers and reviewers whose PR GitHub reports open. */

const ROOT = '/repo'

const agent = (name: string): AgentIdentity =>
  ({
    agentId: `id-${name}`,
    name,
    state: 'exited',
    origin: 'spawned',
    spawnedBy: 'coord',
    cwd: '',
  }) as AgentIdentity

/** Only the allocation row, as after a park, which writes none of its own. */
const allocated = (name: string, branch: string): AgentEventRow => ({
  kind: 'isolation_allocated',
  ts: 1,
  actor: name,
  target: null,
  msgId: null,
  ref: `id-${name}`,
  body: null,
  meta: { strategy: 'worktree', gitRoot: ROOT, worktree: `${ROOT}/.worktrees/${name}`, branch },
})

const openSet =
  (...branches: string[]): OpenPrRead =>
  (root, branch) =>
    Promise.resolve(new Set(branches.map(b => `${ROOT}:${b}`)).has(`${root}:${branch}`))

async function holdFor(
  name: string,
  roster: AgentIdentity[],
  events: AgentEventRow[],
  read: OpenPrRead,
): Promise<string | undefined> {
  const self = roster.find(a => a.name === name) ?? agent(name)
  const target = allocatedWorktree(events, self.agentId)
  return openPrHold(read, heldBranches(self, target, roster, events))
}

describe('reviewedAgentName', () => {
  it.each([
    ['tc-x-2-a-review', 'tc-x-2-a'],
    ['tc-x-3-b-review-r2', 'tc-x-3-b'],
    ['tc-x-1-a-r1', 'tc-x-1-a'],
  ])('reads %s as a reviewer of %s', (name, base) => {
    expect(reviewedAgentName(name)).toBe(base)
  })

  it('does not read a name that only contains "review" as a reviewer', () => {
    expect(reviewedAgentName('tc-x-1-reviewer')).toBeUndefined()
    expect(reviewedAgentName('tc-x-1-a')).toBeUndefined()
  })
})

describe('openPrHold over heldBranches', () => {
  it('holds an implementer whose own branch is open', async () => {
    const events = [allocated('tc-x-1-a', 'agent-chat/tc-x-1-a')]

    const reason = await holdFor('tc-x-1-a', [agent('tc-x-1-a')], events, openSet('agent-chat/tc-x-1-a'))

    expect(reason).toBe('open PR on agent-chat/tc-x-1-a (kept until merged or closed)')
  })

  it('holds an attempt-suffixed agent whose allocated branch is open', async () => {
    const events = [allocated('tc-x-5-a3', 'agent-chat/tc-x-5-a')]

    const reason = await holdFor('tc-x-5-a3', [agent('tc-x-5-a3')], events, openSet('agent-chat/tc-x-5-a'))

    expect(reason).toBe('open PR on agent-chat/tc-x-5-a (kept until merged or closed)')
  })

  it.each(['tc-x-1-a-review', 'tc-x-1-a-review-r2', 'tc-x-1-a-r1'])(
    'holds reviewer %s on its own PR-less branch while the base branch is open',
    async name => {
      const roster = [agent('tc-x-1-a'), agent(name)]
      const events = [allocated('tc-x-1-a', 'agent-chat/tc-x-1-a'), allocated(name, `agent-chat/${name}`)]

      const reason = await holdFor(name, roster, events, openSet('agent-chat/tc-x-1-a'))

      expect(reason).toBe('open PR on agent-chat/tc-x-1-a (kept until merged or closed)')
    },
  )

  it("holds a reviewer whose base agent works on a non-default branch, read from the base's allocation", async () => {
    const roster = [agent('tc-x-4-lint'), agent('tc-x-4-lint-review')]
    const events = [
      allocated('tc-x-4-lint', 'fix/x-4-lint-wrap'),
      allocated('tc-x-4-lint-review', 'agent-chat/tc-x-4-lint-review'),
    ]

    const reason = await holdFor('tc-x-4-lint-review', roster, events, openSet('fix/x-4-lint-wrap'))

    expect(reason).toBe('open PR on fix/x-4-lint-wrap (kept until merged or closed)')
  })

  it('lets every case go once its PR is merged or closed', async () => {
    const roster = [agent('tc-x-4-lint'), agent('tc-x-4-lint-review'), agent('tc-x-5-a3')]
    const events = [
      allocated('tc-x-4-lint', 'fix/x-4-lint-wrap'),
      allocated('tc-x-4-lint-review', 'agent-chat/tc-x-4-lint-review'),
      allocated('tc-x-5-a3', 'agent-chat/tc-x-5-a'),
    ]

    for (const a of roster) expect(await holdFor(a.name, roster, events, openSet())).toBeUndefined()
  })

  it('holds the agent when gh cannot be read', async () => {
    const events = [allocated('tc-x-1-a', 'agent-chat/tc-x-1-a')]
    const failing: OpenPrRead = () => Promise.reject(new Error('gh: HTTP 502\nmore detail'))

    const reason = await holdFor('tc-x-1-a', [agent('tc-x-1-a')], events, failing)

    expect(reason).toBe('could not tell whether agent-chat/tc-x-1-a has an open PR (gh: HTTP 502)')
  })

  it('asks nothing for an agent that has no repo to ask', async () => {
    const read = vi.fn(openSet('agent-chat/tc-x-1-reviewer'))

    const reason = await holdFor('tc-x-1-reviewer', [agent('tc-x-1-reviewer')], [], read)

    expect(reason).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('memoizeOpenPr', () => {
  it('asks gh once per branch for two reviewers of the same base', async () => {
    const roster = [agent('tc-x-1-a'), agent('tc-x-1-a-review'), agent('tc-x-1-a-r1')]
    const events = [
      allocated('tc-x-1-a', 'agent-chat/tc-x-1-a'),
      allocated('tc-x-1-a-review', 'agent-chat/tc-x-1-a-review'),
      allocated('tc-x-1-a-r1', 'agent-chat/tc-x-1-a-r1'),
    ]
    const read = vi.fn(openSet())
    const memo = memoizeOpenPr(read)

    await holdFor('tc-x-1-a-review', roster, events, memo)
    await holdFor('tc-x-1-a-r1', roster, events, memo)

    const baseReads = read.mock.calls.filter(([, branch]) => branch === 'agent-chat/tc-x-1-a')
    expect(baseReads).toHaveLength(1)
  })
})
