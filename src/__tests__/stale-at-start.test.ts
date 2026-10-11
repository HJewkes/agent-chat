import { describe, expect, it } from 'vitest'
import { isStaleLive, staleAtStart } from '../agents/detached-reap.js'
import type { AgentIdentity, AgentLifecycle } from '../protocol.js'

/** CC-489: which rows a broker start offers the reaper, and when a live one stops being stale. */

const row = (agentId: string, state: AgentLifecycle, exitedAt?: number): AgentIdentity =>
  ({ agentId, state, lastEventAt: 10, ...(exitedAt === undefined ? {} : { exitedAt }) }) as AgentIdentity

describe('the rows a broker start offers the reaper', () => {
  it('takes live, spawning and detached rows with no exit, and no terminal ones', () => {
    const roster = [
      row('live', 'live'),
      row('spawning', 'spawning'),
      row('detached', 'detached'),
      row('exited', 'exited', 5),
      row('retired', 'retired'),
      row('reattached-after-exit', 'live', 5),
    ]

    const stale = staleAtStart(roster)

    expect([...stale.keys()]).toEqual(['live', 'spawning', 'detached'])
    expect(stale.get('live')).toBe(10)
  })

  it('stops calling a live row stale once it has written a row since the start', () => {
    expect(isStaleLive(row('a', 'live'), 10)).toBe(true)
    expect(isStaleLive({ ...row('a', 'live'), lastEventAt: 11 }, 10)).toBe(false)
    expect(isStaleLive(row('a', 'live'), undefined)).toBe(false)
    expect(isStaleLive(row('a', 'detached'), 10)).toBe(false)
  })
})
