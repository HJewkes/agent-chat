import { describe, expect, it } from 'vitest'
import { Registry } from '../broker/registry.js'

const conn = (id: string) => ({ id })
const register = (registry: Registry<object>, c: object, name: string) =>
  registry.register(c, { name, workingOn: `${name}'s work`, cwd: `/tmp/${name}`, pid: 1 })

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
    expect(last.escalate).toEqual({ from: 'bob', to: 'alice', depth: 20 })
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
