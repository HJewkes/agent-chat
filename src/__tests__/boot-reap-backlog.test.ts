import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../agents/claude-sessions.js'
import type { ProcessProbe } from '../agents/detached-reap.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/**
 * CC-476: a restart that found 253 detached rows with no launcher pid reaped them back
 * to back on the event loop, and the broker answered no query for two minutes. Each
 * reap re-folded every agent row in the log, twice. A backlog must now drain in
 * batches that leave the loop free, and every rule CC-450 and CC-454 set still holds.
 */

const SETTLE_MS = 50
const BACKLOG = 300
const HISTORY = 2000

let h: RestartHarness
let records: SessionRecord[]
let recordReads = 0

const probe: ProcessProbe = {
  isAlive: () => false,
  readArgv: () => undefined,
  sessionRecords: () => {
    recordReads += 1
    return records
  },
}

afterEach(() => {
  h?.close()
  vi.useRealTimers()
})

function adopt(name: string): string {
  const agentId = h.core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: name,
    meta: { origin: 'adopted', name, cwd: '/tmp/synthetic', session_id: `session-${name}`, depth: '0' },
  }).msgId
  h.core.append({ kind: 'agent_attached', actor: name, ref: agentId })
  return agentId
}

/** A long agent history, then `BACKLOG` sessions left detached when the broker stops. */
function seedBacklog(): string[] {
  records = [{ pid: 1, sessionId: 'a-session-nobody-here-holds' }]
  recordReads = 0
  h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
  for (let i = 0; i < HISTORY; i += 1) {
    const agentId = adopt(`old-${i}`)
    h.core.append({ kind: 'agent_exited', actor: `old-${i}`, ref: agentId, meta: { code: '0' } })
  }
  return Array.from({ length: BACKLOG }, (_, i) => {
    const agentId = adopt(`gone-${i}`)
    h.core.append({ kind: 'agent_detached', actor: `gone-${i}`, ref: agentId })
    return agentId
  })
}

const stillDetached = (): number => h.core.agents.roster().filter(a => a.state === 'detached').length
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The longest the event loop went without running a 5 ms timer, while `done` is false. */
async function longestStall(done: () => boolean): Promise<number> {
  let longest = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 5)
  while (!done()) await tick(20)
  clearInterval(timer)
  return longest
}

describe('a broker restart over a backlog of detached rows with no launcher pid', () => {
  it('keeps answering while it reaps all of them', async () => {
    seedBacklog()

    h.restart()
    const stall = await longestStall(() => stillDetached() === 0)

    expect(stall).toBeLessThan(1000)
    const inferred = h.core.events.agentEvents().filter(r => r.kind === 'agent_exited' && r.meta.inferred)
    expect(inferred).toHaveLength(BACKLOG)
  })

  it('reads the session records once per batch, not once per row', () => {
    // Real timers spread the 300 settle timers over several ms, so the first batches can
    // run short (a drain turn finds only the rows due so far) and the batch count drifts.
    // Fake timers fire them all in one advance: one lone first row, then full batches.
    vi.useFakeTimers()
    seedBacklog()

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS * 20)

    expect(stillDetached()).toBe(0)
    expect(recordReads).toBeLessThanOrEqual(Math.ceil(BACKLOG / 25) + 1)
  })

  it('reaps nothing when no session records can be read', async () => {
    seedBacklog()
    records = []

    h.restart()
    await tick(SETTLE_MS * 4)

    expect(stillDetached()).toBe(BACKLOG)
  })

  it('spares a row that reattaches while it waits for its batch', () => {
    vi.useFakeTimers()
    const ids = seedBacklog()
    const last = ids[ids.length - 1] ?? ''

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(stillDetached()).toBeGreaterThan(0)
    h.core.append({ kind: 'agent_attached', actor: `gone-${BACKLOG - 1}`, ref: last })
    vi.advanceTimersByTime(SETTLE_MS * 10)

    expect(stillDetached()).toBe(0)
    expect(h.core.agents.get(last)?.state).toBe('live')
    expect(h.core.events.agentEvents().filter(r => r.kind === 'agent_exited' && r.ref === last)).toHaveLength(
      0,
    )
  })
})

describe('looking up one agent', () => {
  it('matches the roster for every identity in a mixed history', () => {
    seedBacklog()

    for (const agent of h.core.agents.roster({ includeRetired: true })) {
      expect(h.core.agents.get(agent.agentId)).toEqual(agent)
    }
  })
})
