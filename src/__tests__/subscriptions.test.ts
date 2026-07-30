import { describe, expect, it, vi } from 'vitest'
import { Registry } from '../broker/registry.js'
import { SystemEventFeed } from '../broker/subscriptions.js'
import { SUBSCRIBABLE_KINDS, type Subscription, type SystemEvent } from '../protocol.js'

/**
 * Subscriptions are a FILTER over rows the log already writes. What these prove
 * is the scoping (CC-21's answer: subscription and tags, not a boundary) and the
 * two properties that keep it from becoming either a wiretap or a firehose.
 */

const conn = (id: string) => ({ id })

const register = (
  registry: Registry<object>,
  c: object,
  name: string,
  extra: { tags?: string[]; subscriptions?: Subscription[] } = {},
) => registry.register(c, { name, workingOn: '', cwd: `/tmp/${name}`, pid: 1, ...extra })

const watch = (...kinds: string[]): Subscription[] => [
  { selector: { all: true }, kinds: kinds as Subscription['kinds'] },
]

describe('subscription scoping', () => {
  it('pushes a global subscriber events about anyone else', () => {
    const registry = new Registry<object>()
    const [watcher, other] = [conn('w'), conn('o')]
    register(registry, watcher, 'watcher', { subscriptions: watch('registered') })
    register(registry, other, 'other')

    expect(registry.subscribersFor({ kind: 'registered', subject: 'other' })).toEqual([watcher])
  })

  it('never tells a session about itself, which is pure noise', () => {
    const registry = new Registry<object>()
    const watcher = conn('w')
    register(registry, watcher, 'watcher', { subscriptions: watch('registered') })

    expect(registry.subscribersFor({ kind: 'registered', subject: 'watcher' })).toEqual([])
  })

  it('matches a name selector only for that agent', () => {
    const registry = new Registry<object>()
    const watcher = conn('w')
    register(registry, watcher, 'watcher', {
      subscriptions: [{ selector: { name: 'scout' }, kinds: ['agent_exited'] }],
    })

    expect(registry.subscribersFor({ kind: 'agent_exited', subject: 'scout' })).toEqual([watcher])
    expect(registry.subscribersFor({ kind: 'agent_exited', subject: 'someone-else' })).toEqual([])
  })

  /**
   * The tag is read off the SUBJECT, not the subscriber: "tell me about the
   * agent-teams agents" is a question about them, not about me. Matching on the
   * subscriber's own tags would silently make it "tell me about my own team".
   */
  it('matches a tag selector against the subject tags, not the subscriber tags', () => {
    const registry = new Registry<object>()
    const [watcher, tagged, untagged] = [conn('w'), conn('t'), conn('u')]
    register(registry, watcher, 'watcher', {
      tags: ['unrelated'],
      subscriptions: [{ selector: { tag: 'agent-teams' }, kinds: ['agent_attached'] }],
    })
    register(registry, tagged, 'tagged', { tags: ['agent-teams', 'other'] })
    register(registry, untagged, 'untagged', { tags: ['other'] })

    expect(registry.subscribersFor({ kind: 'agent_attached', subject: 'tagged' })).toEqual([watcher])
    expect(registry.subscribersFor({ kind: 'agent_attached', subject: 'untagged' })).toEqual([])
  })

  /**
   * `spawnedBy` is provenance rather than naming: it must resolve from what the
   * watcher itself spawned, not from any name or tag the subject happens to
   * carry, and it must never leak across to a connection that spawned something
   * else entirely.
   */
  it('matches a spawnedBy selector against what the subscriber itself spawned', () => {
    const registry = new Registry<object>()
    const [watcher, otherSpawner] = [conn('w'), conn('s')]
    register(registry, watcher, 'watcher', {
      subscriptions: [{ selector: { spawnedBy: 'self' }, kinds: ['agent_attached'] }],
    })
    register(registry, otherSpawner, 'other-spawner')
    registry.recordSpawn(watcher, 'scout')
    registry.recordSpawn(otherSpawner, 'ranger')

    expect(registry.subscribersFor({ kind: 'agent_attached', subject: 'scout' })).toEqual([watcher])
    expect(registry.subscribersFor({ kind: 'agent_attached', subject: 'ranger' })).toEqual([])
  })

  it('filters by kind, so a leave subscriber is not woken by a join', () => {
    const registry = new Registry<object>()
    const [watcher, other] = [conn('w'), conn('o')]
    register(registry, watcher, 'watcher', { subscriptions: watch('deregistered') })
    register(registry, other, 'other')

    expect(registry.subscribersFor({ kind: 'deregistered', subject: 'other' })).toEqual([watcher])
    expect(registry.subscribersFor({ kind: 'registered', subject: 'other' })).toEqual([])
  })

  it('suppresses pushes to a session in do-not-disturb', () => {
    const registry = new Registry<object>()
    const [watcher, other] = [conn('w'), conn('o')]
    register(registry, watcher, 'watcher', { subscriptions: watch('registered') })
    register(registry, other, 'other')
    registry.setStatus(watcher, 'working', undefined, true)

    expect(registry.subscribersFor({ kind: 'registered', subject: 'other' })).toEqual([])
  })
})

describe('managing subscriptions', () => {
  it('replaces a rule with the same scope rather than accumulating duplicates', () => {
    const registry = new Registry<object>()
    const watcher = conn('w')
    register(registry, watcher, 'watcher')

    registry.subscribe(watcher, [{ selector: { all: true }, kinds: ['registered'] }])
    const second = registry.subscribe(watcher, [{ selector: { all: true }, kinds: ['deregistered'] }])

    expect(second.held).toBe(1)
    expect(registry.subscribersFor({ kind: 'deregistered', subject: 'other' })).toEqual([watcher])
    expect(registry.subscribersFor({ kind: 'registered', subject: 'other' })).toEqual([])
  })

  it('treats subscribing to no kinds as dropping the rule', () => {
    const registry = new Registry<object>()
    const watcher = conn('w')
    register(registry, watcher, 'watcher', { subscriptions: watch('registered') })

    expect(registry.subscribe(watcher, [{ selector: { all: true }, kinds: [] }]).held).toBe(0)
  })

  it('drops one rule by scope, or all of them when given none', () => {
    const registry = new Registry<object>()
    const watcher = conn('w')
    register(registry, watcher, 'watcher')
    registry.subscribe(watcher, [
      { selector: { all: true }, kinds: ['registered'] },
      { selector: { name: 'scout' }, kinds: ['agent_exited'] },
    ])

    expect(registry.unsubscribe(watcher, { name: 'scout' }).held).toBe(1)
    expect(registry.unsubscribe(watcher).held).toBe(0)
  })

  it('refuses to subscribe a connection that has not registered', () => {
    const registry = new Registry<object>()

    expect(registry.subscribe(conn('ghost'), watch('registered')).ok).toBe(false)
  })

  /** Re-declared on register, which is how a resumed agent gets them back. */
  it('keeps tags and subscriptions across a re-register that omits them', () => {
    const registry = new Registry<object>()
    const watcher = conn('w')
    register(registry, watcher, 'watcher', { tags: ['team'], subscriptions: watch('registered') })
    register(registry, watcher, 'watcher')

    expect(registry.tagsOf(watcher).map(t => t.tag)).toEqual(['team'])
    expect(registry.subscribersFor({ kind: 'registered', subject: 'other' })).toEqual([watcher])
  })
})

describe('the system event feed', () => {
  const feedWith = (registry: Registry<object>) => {
    const pushed: { conn: object; events: SystemEvent[] }[] = []
    const feed = new SystemEventFeed<object>(registry, (c, events) => void pushed.push({ conn: c, events }))
    return { feed, pushed }
  }

  /**
   * Three agents starting together is one thing that happened. Per-row pushes
   * would make CC-16 (peer traffic lengthening turns) worse for no information.
   */
  it('coalesces a burst into a single batched push', () => {
    vi.useFakeTimers()
    const registry = new Registry<object>()
    const [watcher, other] = [conn('w'), conn('o')]
    register(registry, watcher, 'watcher', { subscriptions: watch('registered') })
    register(registry, other, 'other')
    const { feed, pushed } = feedWith(registry)

    for (const name of ['col1', 'col2', 'col3']) feed.offer({ kind: 'registered', actor: name })
    expect(pushed).toHaveLength(0)
    vi.advanceTimersByTime(300)

    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.events.map(e => e.subject)).toEqual(['col1', 'col2', 'col3'])
    vi.useRealTimers()
    feed.close()
  })

  /**
   * Two independent defences, so this asserts both. The earlier version of this
   * test subscribed to everything, offered a `message` row, and checked nothing
   * arrived — but `offer` returns on the row kind BEFORE consulting any
   * subscription, so it would have passed identically with no subscriptions at
   * all. It proved the early return and nothing else.
   */
  it('refuses to store a non-subscribable kind, even from a raw client', () => {
    const registry = new Registry<object>()
    const watcher = conn('w')
    register(registry, watcher, 'watcher')

    // Bypasses the tool handler entirely, as anything on the 0600 socket can.
    registry.subscribe(watcher, [{ selector: { all: true }, kinds: ['message', 'registered'] as never }])

    expect(registry.subscribersFor({ kind: 'message', subject: 'other' })).toEqual([])
    // The legitimate kind in the same call survives, so this filters rather than rejects.
    expect(registry.subscribersFor({ kind: 'registered', subject: 'other' })).toEqual([watcher])
  })

  it('never builds a system event from a content row, whatever is stored', () => {
    vi.useFakeTimers()
    const registry = new Registry<object>()
    const [watcher, other] = [conn('w'), conn('o')]
    register(registry, watcher, 'watcher', { subscriptions: watch(...SUBSCRIBABLE_KINDS) })
    register(registry, other, 'other')
    const { feed, pushed } = feedWith(registry)

    // A lifecycle row proves the watcher IS wired up — without this control, the
    // assertion below cannot tell suppression from a subscriber that never matched.
    feed.offer({ kind: 'registered', actor: 'other' })
    feed.offer({ kind: 'message', actor: 'other', target: 'someone', body: 'the secret' })
    vi.advanceTimersByTime(300)

    const kinds = pushed.flatMap(p => p.events.map(e => e.kind))
    expect(kinds).toEqual(['registered'])
    expect(JSON.stringify(pushed)).not.toContain('the secret')
    vi.useRealTimers()
    feed.close()
  })

  it('drops a subscriber that disconnected mid-window instead of writing to it', () => {
    vi.useFakeTimers()
    const registry = new Registry<object>()
    const [watcher, other] = [conn('w'), conn('o')]
    register(registry, watcher, 'watcher', { subscriptions: watch('registered') })
    register(registry, other, 'other')
    const pushed: object[] = []
    const feed = new SystemEventFeed<object>(registry, c => {
      // A real socket throws once closed; this stands in for that.
      if (c === watcher) throw new Error('write after end')
      pushed.push(c)
    })

    feed.offer({ kind: 'registered', actor: 'other' })
    expect(() => vi.advanceTimersByTime(300)).not.toThrow()

    vi.useRealTimers()
    feed.close()
  })

  it('resolves the subject as target then actor', () => {
    vi.useFakeTimers()
    const registry = new Registry<object>()
    const [watcher, other] = [conn('w'), conn('o')]
    register(registry, watcher, 'watcher', { subscriptions: watch('agent_spawned', 'agent_exited') })
    register(registry, other, 'other')
    const { feed, pushed } = feedWith(registry)

    // agent_spawned names the agent in target, with the spawner as actor.
    feed.offer({ kind: 'agent_spawned', actor: 'spawner', target: 'scout' })
    // agent_exited carries only actor.
    feed.offer({ kind: 'agent_exited', actor: 'scout' })
    vi.advanceTimersByTime(300)

    expect(pushed[0]?.events.map(e => e.subject)).toEqual(['scout', 'scout'])
    vi.useRealTimers()
    feed.close()
  })
})
