import { describe, expect, it } from 'vitest'
import { Registry } from '../broker/registry.js'

const conn = (id: string) => ({ id })
const register = (registry: Registry<object>, c: object, name: string) =>
  registry.register(c, { name, workingOn: `${name}'s work`, cwd: `/tmp/${name}`, pid: 1 })

/**
 * Regression: a spawn that named no cwd fell through to `process.cwd()` in the
 * SUPERVISOR, which runs inside the broker — and the broker is autostarted by
 * whichever client connects first, so its cwd is an arbitrary repo. A live spawn
 * from this checkout ran its agent in ~/projects/relay. The requester's own cwd
 * is the only meaningful default, and the registry is where it already lived.
 *
 * This covers the accessor, not the socket wiring that consumes it; there is no
 * socket-level spawn harness yet.
 */
describe('the requester cwd a spawn defaults to', () => {
  it('reports the cwd the session registered with', () => {
    const registry = new Registry<object>()
    const alice = conn('a')
    register(registry, alice, 'alice')

    expect(registry.cwdFor(alice)).toBe('/tmp/alice')
  })

  it('reports nothing for an unregistered connection, rather than a stale or default path', () => {
    const registry = new Registry<object>()

    expect(registry.cwdFor(conn('ghost'))).toBeUndefined()
  })
})

describe('Registry routing', () => {
  it('delivers a directed message to exactly one session', () => {
    const registry = new Registry<object>()
    const [alice, bob, carol] = [conn('a'), conn('b'), conn('c')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    register(registry, carol, 'carol')

    const result = registry.send(alice, 'bob', 'take the left slot')

    expect(result.ok).toBe(true)
    expect(result.recipients).toEqual(['bob'])
    expect(result.deliveries).toHaveLength(1)
    expect(result.deliveries[0]?.conn).toBe(bob)
    expect(result.deliveries[0]?.message.from).toBe('alice')
  })

  it('refuses an unknown recipient without falling back to a broadcast', () => {
    const registry = new Registry<object>()
    const [alice, bob] = [conn('a'), conn('b')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')

    const result = registry.send(alice, 'dave', 'hello?')

    expect(result.ok).toBe(false)
    expect(result.deliveries).toHaveLength(0)
    expect(result.reason).toContain('no active session named "dave"')
  })

  it('refuses to send to yourself', () => {
    const registry = new Registry<object>()
    const alice = conn('a')
    register(registry, alice, 'alice')

    expect(registry.send(alice, 'alice', 'hi me').ok).toBe(false)
  })

  it('broadcasts to everyone except the sender', () => {
    const registry = new Registry<object>()
    const [alice, bob, carol] = [conn('a'), conn('b'), conn('c')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    register(registry, carol, 'carol')

    const result = registry.broadcast(alice, 'switching branches')

    expect(result.recipients.sort()).toEqual(['bob', 'carol'])
    expect(result.deliveries.map(d => d.conn)).not.toContain(alice)
    expect(result.deliveries[0]?.message.broadcast).toBe(true)
  })

  it('carries in_reply_to so a reply can be correlated', () => {
    const registry = new Registry<object>()
    const [alice, bob] = [conn('a'), conn('b')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')

    const first = registry.send(alice, 'bob', 'can you take the left slot?')
    const answer = registry.send(bob, 'alice', 'yes', first.msgId)

    expect(answer.deliveries[0]?.message.inReplyTo).toBe(first.msgId)
  })
})

describe('Registry multicast', () => {
  const quartet = (now: () => number = Date.now) => {
    const registry = new Registry<object>(now)
    const [alice, bob, carol, dave] = [conn('a'), conn('b'), conn('c'), conn('d')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    register(registry, carol, 'carol')
    register(registry, dave, 'dave')
    return { registry, alice, bob, carol, dave }
  }

  it('delivers to exactly the named sessions and nobody else', () => {
    const { registry, alice, bob, carol } = quartet()

    const result = registry.multicast(alice, ['bob', 'carol'], 'standup in five')

    expect(result.ok).toBe(true)
    expect(result.recipients).toEqual(['bob', 'carol'])
    expect(result.deliveries.map(d => d.conn).sort()).toEqual([bob, carol].sort())
    expect(result.results).toEqual([
      { name: 'bob', status: 'delivered' },
      { name: 'carol', status: 'delivered' },
    ])
  })

  it('sends ONE message, so replies thread and depth accounting stays coherent', () => {
    const { registry, alice } = quartet()

    const result = registry.multicast(alice, ['bob', 'carol'], 'standup in five')

    const ids = new Set(result.deliveries.map(d => d.message.msgId))
    expect([...ids]).toEqual([result.msgId])
  })

  it('tells each recipient who else was addressed', () => {
    const { registry, alice } = quartet()

    const result = registry.multicast(alice, ['bob', 'carol'], 'standup in five')

    expect(result.deliveries[0]?.message.audience).toEqual(['bob', 'carol'])
    // Not a broadcast: recipients must not read it as "everyone already knows".
    expect(result.deliveries[0]?.message.broadcast).toBeUndefined()
  })

  it('leaves a directed send and a broadcast without an audience', () => {
    const { registry, alice } = quartet()

    expect(registry.send(alice, 'bob', 'just you').deliveries[0]?.message.audience).toBeUndefined()
    expect(registry.broadcast(alice, 'everyone').deliveries[0]?.message.audience).toBeUndefined()
    // One resolvable name IS a directed send, whatever the caller spelled.
    expect(registry.multicast(alice, ['bob'], 'just you').deliveries[0]?.message.audience).toBeUndefined()
  })

  it('reports an unknown name per recipient rather than failing the whole call', () => {
    const { registry, alice, bob } = quartet()

    const result = registry.multicast(alice, ['bob', 'gamma'], 'heads up')

    expect(result.ok).toBe(true)
    expect(result.recipients).toEqual(['bob'])
    expect(result.deliveries.map(d => d.conn)).toEqual([bob])
    expect(result.results).toEqual([
      { name: 'bob', status: 'delivered' },
      { name: 'gamma', status: 'no_such_session', reason: 'no active session named "gamma"' },
    ])
  })

  it('reports the sender addressing itself without dropping the rest', () => {
    const { registry, alice } = quartet()

    const result = registry.multicast(alice, ['alice', 'bob'], 'heads up')

    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ name: 'alice', status: 'self' })
    expect(result.recipients).toEqual(['bob'])
  })

  it('fails only when nobody could take it', () => {
    const { registry, alice } = quartet()

    const result = registry.multicast(alice, ['gamma', 'delta'], 'anyone?')

    expect(result.ok).toBe(false)
    expect(result.deliveries).toHaveLength(0)
    expect(result.results.map(r => r.status)).toEqual(['no_such_session', 'no_such_session'])
  })

  it('holds per recipient for do-not-disturb, exactly as a broadcast does', () => {
    const { registry, alice, bob } = quartet()
    registry.setStatus(bob, 'working', undefined, true)

    const result = registry.multicast(alice, ['bob', 'carol'], 'standup in five')

    expect(result.results).toEqual([
      { name: 'bob', status: 'held' },
      { name: 'carol', status: 'delivered' },
    ])
    const byName = new Map(result.deliveries.map(d => [registry.nameOf(d.conn), d.live]))
    expect(byName.get('bob')).toBe(false)
    expect(byName.get('carol')).toBe(true)
  })

  it('collapses a name addressed twice, so a typo cannot double-charge a peer', () => {
    const { registry, alice } = quartet()

    const result = registry.multicast(alice, ['bob', 'bob'], 'once please')

    expect(result.recipients).toEqual(['bob'])
    expect(result.deliveries).toHaveLength(1)
  })

  it('carries in_reply_to and thread depth like any other message', () => {
    const { registry, alice, bob } = quartet()
    const first = registry.send(bob, 'alice', 'what next?')

    const answer = registry.multicast(alice, ['bob', 'carol'], 'this next', first.msgId)

    expect(answer.deliveries[0]?.message.inReplyTo).toBe(first.msgId)
    expect(answer.deliveries[0]?.message.threadDepth).toBe(2)
  })

  it('refuses a recipient the sender has already hit the rate limit with', () => {
    const { registry, alice } = quartet()
    for (let i = 0; i < 20; i++) registry.send(alice, 'bob', `fresh thread ${i}`)

    const result = registry.multicast(alice, ['bob', 'carol'], 'and one more')

    expect(result.results[0]).toMatchObject({ name: 'bob', status: 'refused' })
    expect(result.recipients).toEqual(['carol'])
  })
})

/**
 * The anti-bypass property, and the reason multicast could not simply skip the
 * fanout budget: without this, naming every registered session in one chat_send
 * is a broadcast that costs nothing, and the only control this bus has against
 * the traffic it was built to catch is one argument away from irrelevant.
 */
describe('Registry multicast fanout budget', () => {
  const quartet = (now: () => number) => {
    const registry = new Registry<object>(now)
    const [alice, bob, carol, dave] = [conn('a'), conn('b'), conn('c'), conn('d')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    register(registry, carol, 'carol')
    register(registry, dave, 'dave')
    return { registry, alice }
  }

  const big = 'x'.repeat(5000)

  it('charges a multicast the same amplified bytes a broadcast pays', () => {
    const { registry, alice } = quartet(() => 0)

    registry.multicast(alice, ['bob', 'carol', 'dave'], big)
    const second = registry.multicast(alice, ['bob', 'carol', 'dave'], big)

    expect(second.suppressLive).toBe(true)
    // Held, not lost: every addressee still has it in their inbox.
    expect(second.deliveries).toHaveLength(3)
    expect(second.reason).toContain('inbox')
  })

  it('spends the SAME ledger as broadcast, so alternating the two is not a way round it', () => {
    const { registry, alice } = quartet(() => 0)

    registry.broadcast(alice, big)
    expect(registry.multicast(alice, ['bob', 'carol', 'dave'], big).suppressLive).toBe(true)
  })

  it('leaves a two-name multicast charged and a one-name one free', () => {
    const { registry, alice } = quartet(() => 0)

    // 5000 bytes x 2 recipients, twice, is past the 16k budget.
    registry.multicast(alice, ['bob', 'carol'], big)
    expect(registry.multicast(alice, ['bob', 'carol'], big).suppressLive).toBe(true)
    // A single recipient is a directed message and is never throttled.
    expect(registry.multicast(alice, ['dave'], big).suppressLive).toBeFalsy()
    expect(registry.send(alice, 'dave', big).suppressLive).toBeFalsy()
  })

  it('lets the budget recover once the window has passed', () => {
    let clock = 0
    const { registry, alice } = quartet(() => clock)
    registry.multicast(alice, ['bob', 'carol', 'dave'], big)
    expect(registry.multicast(alice, ['bob', 'carol', 'dave'], big).suppressLive).toBe(true)

    clock += 61_000

    expect(registry.multicast(alice, ['bob', 'carol', 'dave'], big).suppressLive).toBeFalsy()
  })
})

describe('Registry leases', () => {
  it('rejects a name held by a live session', () => {
    const registry = new Registry<object>()
    const [bob, impostor] = [conn('b'), conn('i')]
    register(registry, bob, 'bob')

    expect(register(registry, impostor, 'bob').ok).toBe(false)
  })

  it('releases the name and the route when the session drops', () => {
    const registry = new Registry<object>()
    const [alice, bob, replacement] = [conn('a'), conn('b'), conn('r')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')

    registry.drop(bob)

    expect(registry.send(alice, 'bob', 'still there?').ok).toBe(false)
    expect(register(registry, replacement, 'bob').ok).toBe(true)
    expect(registry.send(alice, 'bob', 'welcome back').ok).toBe(true)
  })

  it('keeps status across a re-register on the same connection', () => {
    const registry = new Registry<object>()
    const bob = conn('b')
    register(registry, bob, 'bob')
    registry.setStatus(bob, 'blocked')

    register(registry, bob, 'bob')

    expect(registry.list().find(s => s.name === 'bob')?.status).toBe('blocked')
  })

  it('refuses reserved names so a session cannot register as the human', () => {
    const registry = new Registry<object>()
    const impostor = conn('i')

    expect(register(registry, impostor, 'human').ok).toBe(false)
    expect(register(registry, impostor, 'Human').ok).toBe(false)
    expect(register(registry, impostor, 'system').ok).toBe(false)
    expect(register(registry, impostor, 'alice').ok).toBe(true)
  })
})

describe('Registry directory', () => {
  it('reports status and working_on for each session', () => {
    const registry = new Registry<object>()
    const alice = conn('a')
    register(registry, alice, 'alice')
    registry.setStatus(alice, 'working', 'the dashboard')

    expect(registry.list()).toEqual([
      expect.objectContaining({
        name: 'alice',
        status: 'working',
        workingOn: 'the dashboard',
        cwd: '/tmp/alice',
      }),
    ])
  })
})

/** Walks a reply chain, returning the result of the last (possibly refused) hop. */
function replyChain(registry: Registry<object>, alice: object, bob: object, hops: number) {
  let result = registry.send(alice, 'bob', 'hop 1')
  let inReplyTo = result.msgId
  for (let hop = 2; hop <= hops; hop++) {
    const fromAlice = hop % 2 === 1
    result = registry.send(fromAlice ? alice : bob, fromAlice ? 'bob' : 'alice', `hop ${hop}`, inReplyTo)
    inReplyTo = result.msgId
  }
  return result
}

describe('Registry thread depth', () => {
  const pair = () => {
    const registry = new Registry<object>()
    const [alice, bob] = [conn('a'), conn('b')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    return { registry, alice, bob }
  }

  it('stamps depth 1 on a fresh thread and increments along the chain', () => {
    const { registry, alice, bob } = pair()

    const first = registry.send(alice, 'bob', 'start')
    const second = registry.send(bob, 'alice', 'reply', first.msgId)
    const third = registry.send(alice, 'bob', 'reply again', second.msgId)

    expect(first.deliveries[0]?.message.threadDepth).toBe(1)
    expect(second.deliveries[0]?.message.threadDepth).toBe(2)
    expect(third.deliveries[0]?.message.threadDepth).toBe(3)
  })

  /**
   * The longest real chain on 2026-07-27 ran to depth 5 and every link corrected a
   * genuine error. Guards against anyone tuning the breaker down onto useful work.
   */
  it('delivers a depth-5 chain untouched, with no hint and no refusal', () => {
    const { registry, alice, bob } = pair()

    const last = replyChain(registry, alice, bob, 5)

    expect(last.ok).toBe(true)
    expect(last.deliveries).toHaveLength(1)
    expect(last.deliveries[0]?.message.threadDepth).toBe(5)
    expect(last.deliveries[0]?.message.threadHint).toBeUndefined()
  })

  it('hints at the warning depth but still delivers', () => {
    const { registry, alice, bob } = pair()

    const last = replyChain(registry, alice, bob, 12)

    expect(last.ok).toBe(true)
    expect(last.deliveries).toHaveLength(1)
    expect(last.deliveries[0]?.message.threadHint).toBe('wrap_up')
  })

  it('breaks a runaway thread, delivering nothing and escalating to the human', () => {
    const { registry, alice, bob } = pair()

    const last = replyChain(registry, alice, bob, 20)

    expect(last.ok).toBe(false)
    expect(last.deliveries).toHaveLength(0)
    expect(last.reason).toContain('depth')
    expect(last.escalate).toMatchObject({ from: 'bob', to: 'alice', kind: 'thread_depth', value: 20 })
  })

  it('leaves directed messages on a fresh thread unaffected by a broken one', () => {
    const { registry, alice, bob } = pair()
    replyChain(registry, alice, bob, 20)

    expect(registry.send(alice, 'bob', 'starting over').ok).toBe(true)
  })
})

describe('Registry broadcast budget', () => {
  const trio = (now: () => number) => {
    const registry = new Registry<object>(now)
    const [alice, bob, carol] = [conn('a'), conn('b'), conn('c')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    register(registry, carol, 'carol')
    return { registry, alice }
  }

  const big = 'x'.repeat(5000)

  it('pushes a broadcast live while the sender is under budget', () => {
    const { registry, alice } = trio(() => 0)

    const result = registry.broadcast(alice, big)

    expect(result.ok).toBe(true)
    expect(result.suppressLive).toBeFalsy()
    expect(result.deliveries).toHaveLength(2)
  })

  it('holds an over-budget broadcast without losing it', () => {
    const { registry, alice } = trio(() => 0)

    registry.broadcast(alice, big)
    const second = registry.broadcast(alice, big)

    expect(second.ok).toBe(true)
    expect(second.suppressLive).toBe(true)
    // Still addressed to everyone: suppression is about the push, not the content.
    expect(second.deliveries).toHaveLength(2)
    expect(second.recipients).toEqual(['bob', 'carol'])
    expect(second.reason).toContain('inbox')
  })

  it('lets the budget recover once the window has passed', () => {
    let clock = 0
    const { registry, alice } = trio(() => clock)

    registry.broadcast(alice, big)
    expect(registry.broadcast(alice, big).suppressLive).toBe(true)
    clock += 61_000

    expect(registry.broadcast(alice, big).suppressLive).toBeFalsy()
  })

  it('never throttles a directed message, even with the budget blown', () => {
    const { registry, alice } = trio(() => 0)
    registry.broadcast(alice, big)
    registry.broadcast(alice, big)

    const directed = registry.send(alice, 'bob', big)

    expect(directed.ok).toBe(true)
    expect(directed.suppressLive).toBeFalsy()
  })
})

describe('Registry pair exchange rate', () => {
  const trio = (now: () => number = Date.now) => {
    const registry = new Registry<object>(now)
    const [alice, bob, carol] = [conn('a'), conn('b'), conn('c')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    register(registry, carol, 'carol')
    return { registry, alice, bob, carol }
  }

  /** Sends `count` messages that never reply to anything, so depth stays at 1 throughout. */
  const volleyFreshThreads = (registry: Registry<object>, from: object, to: string, count: number) => {
    const results = []
    for (let i = 0; i < count; i++) results.push(registry.send(from, to, `fresh thread ${i}`))
    return results
  }

  it('catches a pair volleying across fresh threads, which the depth breaker cannot see', () => {
    const { registry, alice } = trio()

    const delivered = volleyFreshThreads(registry, alice, 'bob', 20)
    const refused = registry.send(alice, 'bob', 'and another')

    // Control: every one of these got through, and none of them ever raised depth.
    expect(delivered.every(r => r.ok)).toBe(true)
    expect(delivered.every(r => r.deliveries[0]?.message.threadDepth === 1)).toBe(true)
    // So the depth breaker was never going to fire, and the rate limit is what caught it.
    expect(refused.ok).toBe(false)
    expect(refused.escalate).toMatchObject({ from: 'alice', to: 'bob', kind: 'exchange_rate', value: 20 })
    expect(refused.reason).toContain('new thread does not reset this')
  })

  it('budgets each direction and each peer separately', () => {
    const { registry, alice, bob } = trio()
    volleyFreshThreads(registry, alice, 'bob', 20)

    expect(registry.send(alice, 'bob', 'blocked').ok).toBe(false)
    // The reverse direction is its own budget, and so is a different recipient.
    expect(registry.send(bob, 'alice', 'reply is fine').ok).toBe(true)
    expect(registry.send(alice, 'carol', 'a third party is fine').ok).toBe(true)
  })

  it('lets the rate recover once the window has passed', () => {
    let clock = 0
    const { registry, alice } = trio(() => clock)
    volleyFreshThreads(registry, alice, 'bob', 20)
    expect(registry.send(alice, 'bob', 'blocked').ok).toBe(false)

    clock += 10 * 60_000 + 1

    expect(registry.send(alice, 'bob', 'a fresh window').ok).toBe(true)
  })

  it('does not charge refused sends against the budget', () => {
    const { registry, alice } = trio()
    for (let i = 0; i < 25; i++) registry.send(alice, 'nobody', 'into the void')

    // Those all failed on an unknown recipient, so alice's budget for a real peer is intact.
    expect(registry.send(alice, 'bob', 'still fine').ok).toBe(true)
  })
})

describe('Registry do-not-disturb', () => {
  const trio = () => {
    const registry = new Registry<object>()
    const [alice, bob, carol] = [conn('a'), conn('b'), conn('c')]
    register(registry, alice, 'alice')
    register(registry, bob, 'bob')
    register(registry, carol, 'carol')
    return { registry, alice, bob, carol }
  }

  it('retains a directed message for a quiet session instead of pushing it', () => {
    const { registry, alice, bob } = trio()
    registry.setStatus(bob, 'working', undefined, true)

    const result = registry.send(alice, 'bob', 'are you there?')

    // Routed and logged, just not pushed — that is what makes DND lossless.
    expect(result.ok).toBe(true)
    expect(result.deliveries).toHaveLength(1)
    expect(result.deliveries[0]?.live).toBe(false)
    expect(result.reason).toContain('inbox')
  })

  it('holds a broadcast per recipient rather than for everyone', () => {
    const { registry, alice, bob } = trio()
    registry.setStatus(bob, 'working', undefined, true)

    const result = registry.broadcast(alice, 'switching branches')

    const byName = new Map(result.deliveries.map(d => [registry.nameOf(d.conn), d.live]))
    expect(byName.get('bob')).toBe(false)
    expect(byName.get('carol')).toBe(true)
  })

  it('keeps dnd orthogonal to status, in both directions', () => {
    const { registry, alice, bob } = trio()
    registry.setStatus(bob, 'working', undefined, true)

    // A later status update that says nothing about dnd must not clear it.
    registry.setStatus(bob, 'available')
    expect(registry.send(alice, 'bob', 'still quiet?').deliveries[0]?.live).toBe(false)
    expect(registry.list().find(s => s.name === 'bob')?.status).toBe('available')

    registry.setStatus(bob, 'available', undefined, false)
    expect(registry.send(alice, 'bob', 'back?').deliveries[0]?.live).toBe(true)
  })
})
