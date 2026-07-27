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
