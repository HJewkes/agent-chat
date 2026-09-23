import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../broker/core.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/**
 * CC-109: the slot semaphore is memory only, so a restarted broker started it
 * empty and every agent that reattached ran uncounted. The real ceiling became
 * the cap plus whatever was running before the restart.
 */

let h: RestartHarness

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  h?.close()
  vi.useRealTimers()
})

async function spawnAll(names: readonly string[]): Promise<void> {
  for (const name of names) expect((await h.spawnAgent(name)).ok).toBe(true)
}

describe('slots after a broker restart', () => {
  it('counts every agent that reattaches', async () => {
    h = startSupervisor({ slots: 5 })
    await spawnAll(['a', 'b', 'c'])

    h.restart()
    expect(h.semaphore.inUse).toBe(0)
    h.reattach(['a', 'b', 'c'])

    expect(h.semaphore.inUse).toBe(3)
    expect(h.supervisor.slots()).toBe('3/5 slots')
  })

  it('refuses a new spawn once reattached agents fill the cap', async () => {
    h = startSupervisor({ slots: 2 })
    await spawnAll(['a', 'b'])
    h.restart()
    h.reattach(['a', 'b'])

    const result = await h.spawnAgent('c')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no free agent slots \(2\/2 slots\)/)
  })

  it('never refuses a reattach past the cap, and keeps refusing spawns until below it', async () => {
    h = startSupervisor({ slots: 4 })
    await spawnAll(['a', 'b', 'c', 'd'])
    h.restart({ slots: 2 })

    h.reattach(['a', 'b', 'c', 'd'])

    expect(h.semaphore.inUse).toBe(4)
    expect(h.supervisor.slots()).toBe('4/2 slots')
    expect((await h.spawnAgent('e')).ok).toBe(false)
  })

  it('frees a reattached slot on retire', async () => {
    h = startSupervisor({ slots: 1 })
    await spawnAll(['a'])
    h.restart()
    h.reattach(['a'])

    await h.supervisor.retire('a')

    expect(h.semaphore.inUse).toBe(0)
    expect((await h.spawnAgent('b')).ok).toBe(true)
  })

  it('frees a reattached slot once a detach outlasts the settle window', async () => {
    h = startSupervisor({ slots: 2, settleMs: 1000 })
    await spawnAll(['a'])
    h.restart()
    h.reattach(['a'])
    const agentId = h.core.agents.byName('a')?.agentId ?? ''

    h.core.append({ kind: 'agent_detached', actor: 'a', ref: agentId })
    vi.advanceTimersByTime(999)
    expect(h.semaphore.inUse).toBe(1)
    vi.advanceTimersByTime(1)

    expect(h.semaphore.inUse).toBe(0)
  })

  it('keeps the slot when the agent reattaches inside the settle window', async () => {
    h = startSupervisor({ slots: 2, settleMs: 1000 })
    await spawnAll(['a'])
    h.restart()
    h.reattach(['a'])
    const agentId = h.core.agents.byName('a')?.agentId ?? ''

    h.core.append({ kind: 'agent_detached', actor: 'a', ref: agentId })
    vi.advanceTimersByTime(500)
    h.reattach(['a'])
    vi.advanceTimersByTime(5000)

    expect(h.semaphore.inUse).toBe(1)
  })

  it('does not count a human session, which never held a slot', () => {
    h = startSupervisor({ slots: 2 })
    const conn = {} as unknown as net.Socket as Conn

    h.core.register(conn, {
      t: 'register',
      name: 'human-session',
      workingOn: '',
      cwd: '/tmp',
      pid: 1,
      sessionId: 'human-session-id',
    })

    expect(h.core.agents.bySession('human-session-id')?.state).toBe('live')
    expect(h.semaphore.inUse).toBe(0)
  })
})
