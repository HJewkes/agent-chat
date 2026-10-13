import { describe, expect, it } from 'vitest'
import { waitForSeam, type SeamWait } from '../cli/drain.js'
import type { BlockerSource } from '../cli/restart-guard.js'
import type { AgentIdentity } from '../protocol.js'

const START = 1_000_000_000
const POLL_MS = 1_000
const TEN_MINUTES = 600_000

const spawning = (name: string, spawnedAt: number): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state: 'spawning',
  origin: 'spawned',
  spawnedBy: 'coordinator',
  spawnedAt,
  brief: '',
  cwd: '/tmp',
  isolation: 'none',
  surface: 'headless',
  sessionId: '',
  lastEventAt: spawnedAt,
  generation: 1,
})

/** A clock that only moves when the wait sleeps, and counts the polls. */
const harness = (source: (poll: number) => { agents?: AgentIdentity[]; procs?: string[] }) => {
  let clock = START
  let polls = 0
  const reads = (): ReturnType<typeof source> => source(polls)
  const blockers: BlockerSource = {
    agents: async () => reads().agents ?? [],
  }
  const wait = (deadlineMs: number): SeamWait => ({
    source: blockers,
    procs: async () => {
      const rows = reads().procs ?? []
      polls++
      return rows
    },
    deadlineMs,
    pollMs: POLL_MS,
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
  })
  return { wait, polls: () => polls }
}

describe('waiting for the restart seam', () => {
  it('reaches the seam at the first poll where the mid-spawn agent has attached', async () => {
    const h = harness(poll => ({ agents: poll < 2 ? [spawning('cc-new', START)] : [] }))

    const result = await waitForSeam(h.wait(TEN_MINUTES))

    expect(result).toEqual({ ok: true, waitedMs: 2 * POLL_MS })
    expect(h.polls()).toBe(3)
  })

  it('gives up at the deadline and names a push that never finishes', { timeout: 1_000 }, async () => {
    const h = harness(() => ({ procs: ['4242 /opt/homebrew/bin/git push origin HEAD'] }))

    const result = await waitForSeam(h.wait(TEN_MINUTES))

    expect(result).toEqual({ ok: false, why: ['a git push is running (pid 4242)'] })
    expect(h.polls()).toBe(TEN_MINUTES / POLL_MS + 1)
  })

  it('names every remaining blocker at the deadline, merges included', { timeout: 1_000 }, async () => {
    const h = harness(() => ({
      agents: [spawning('cc-a', START), spawning('cc-b', START)],
      procs: ['12 gh pr merge 5 --squash', '13 seat-merge seat o/r 1 abc /x/clone'],
    }))

    const result = await waitForSeam(h.wait(5 * POLL_MS))

    expect(result).toEqual({ ok: false, why: ['mid-spawn: cc-a, cc-b', 'a merge is running (pid 12,13)'] })
  })

  it('does not wait on a process that only mentions git push in its arguments', async () => {
    const h = harness(() => ({
      procs: ['9 /x/.local/bin/claude run /opt/homebrew/bin/git push origin main'],
    }))

    const result = await waitForSeam(h.wait(TEN_MINUTES))

    expect(result).toEqual({ ok: true, waitedMs: 0 })
  })
})
