import { describe, expect, it, vi } from 'vitest'
import { advance, applyActions, type Action } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { observe, type ObserveDeps } from '../agents/burndown/observe.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-980 b: a spawning claim whose agent already exited lands and is read in the same tick. */

const PR = 'https://github.com/o/r/pull/9'
const DONE = `Status: DONE\nPR: ${PR}`
const NOW = new Date('2026-10-14T12:00:00.000Z')
const EARLIER = '2026-10-14T11:55:00.000Z'

const spawning: Claim = {
  taskId: 'CC-1',
  initiative: 'demo',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  spawnedAt: EARLIER,
  phase: 'spawning',
  phaseAt: EARLIER,
  worktree: '/parked/tree',
}

const rowIn = (state: string, name = 'bd-cc-1'): AgentIdentity =>
  ({ agentId: 'a1', name, state, spawnedAt: 1 }) as AgentIdentity

async function tick(
  claim: Claim,
  row: AgentIdentity,
  deps: Partial<ObserveDeps>,
): Promise<{ actions: Action[]; after: Claim[] }> {
  const { observations } = await observe(
    [claim],
    { agents: [row] },
    {
      root: '/nowhere',
      inboxSince: async () => [],
      finalText: () => 'I fixed the blocking finding and pushed.',
      diff: () => ({ reviewable: true, reason: '1 commit ahead' }),
      exitedWork: () => undefined,
      activity: () => 'unknown',
      progress: () => 'unreadable',
      shepherdRows: () => [],
      openPrs: () => [],
      spendCap: () => undefined,
      spend: async () => ({ ok: false, reason: 'stub' }) as never,
      ...deps,
    },
  )
  const actions = advance([claim], observations, NOW)
  return { actions, after: applyActions({ ...EMPTY_LEDGER, claims: [claim] }, actions, NOW).claims }
}

const updates = (actions: Action[]) => actions.flatMap(a => (a.kind === 'update' ? [a.patch] : []))
const registers = (actions: Action[]) => actions.filter(a => a.kind === 'register')

describe('a spawning claim whose agent already exited (CC-980 b)', () => {
  it('lands and is handed to Shepherd on its broker report in one pass', async () => {
    const { actions, after } = await tick(spawning, rowIn('exited'), { statusReport: () => DONE })

    expect(updates(actions)[0]).toEqual(
      expect.objectContaining({ phase: 'implementing', agentId: 'a1', nextPhase: undefined }),
    )
    expect(registers(actions)).toEqual([
      expect.objectContaining({ registration: expect.objectContaining({ target: { repo: 'o/r', pr: 9 } }) }),
    ])
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', agentId: 'a1' })])
  })

  it('lands as a reviewer and reads its APPROVE verdict in the same pass', async () => {
    const claim: Claim = { ...spawning, agentName: 'bd-cc-1-rev', nextPhase: 'reviewing', pr: PR }

    const { actions, after } = await tick(claim, rowIn('exited', 'bd-cc-1-rev'), {
      finalText: () => 'Verdict: APPROVE',
    })

    expect(updates(actions)[0]).toEqual(expect.objectContaining({ phase: 'reviewing', agentId: 'a1' }))
    expect(registers(actions)).toHaveLength(1)
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding' })])
  })

  it('reads GitHub as the implementing claim it lands as, so a merged PR finishes it', async () => {
    const { after } = await tick(spawning, rowIn('exited'), {
      prState: () => ({ kind: 'merged', pr: PR, head: 'abc' }),
    })

    expect(after).toEqual([expect.objectContaining({ phase: 'done', pr: PR })])
  })
})

describe('a spawning claim whose agent is live', () => {
  it('only lands, without reading a report', async () => {
    const finalText = vi.fn(() => DONE)
    const statusReport = vi.fn(() => DONE)

    const { actions, after } = await tick(spawning, rowIn('live'), { finalText, statusReport })

    expect(actions).toEqual([
      expect.objectContaining({ kind: 'update', patch: expect.objectContaining({ phase: 'implementing' }) }),
    ])
    expect(after).toEqual([expect.objectContaining({ phase: 'implementing', agentId: 'a1' })])
    expect(finalText).not.toHaveBeenCalled()
    expect(statusReport).not.toHaveBeenCalled()
  })
})
