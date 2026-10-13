import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Observation } from '../agents/burndown/advance.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { parseReport } from '../agents/burndown/report.js'
import { releasesSince } from '../agents/burndown/ladder.js'
import { seatEvents } from '../agents/burndown/seat-events.js'

/** CC-1158 slice d: a closed or released parent releases its stacked children; a merged or open one does not. */

const AT = '2026-10-01T12:00:00.000Z'
const NOW = new Date('2026-10-01T12:05:00.000Z')
const REPO = 'example-org/example-repo'
const prUrl = (n: number): string => `https://github.com/${REPO}/pull/${n}`

const claim = (slice: string, over: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'demo',
  spawnedAt: AT,
  phaseAt: AT,
  phase: 'queued',
  slice,
  ...over,
})

const parentClaim = (over: Partial<Claim> = {}): Claim =>
  claim('a', { phase: 'shepherding', pr: prUrl(10), agentName: 'bd-t-1-a', ...over })

const childClaim = (over: Partial<Claim> = {}): Claim =>
  claim('b', {
    phase: 'implementing',
    agentName: 'bd-t-1-b',
    dependsOn: ['a'],
    owns: ['src/b.ts'],
    stackedOn: { taskId: 'T-1', slice: 'a', pr: prUrl(10), branch: 'agent-chat/bd-t-1-a' },
    ...over,
  })

const run = (claims: Claim[], parentObs: Observation = {}) =>
  advance(claims, new Map([[claimKey(claims[0] ?? claim('a')), parentObs]]), NOW)

const releases = (actions: ReturnType<typeof run>) => actions.filter(a => a.kind === 'release')

describe('stack-broken release', () => {
  it('releases a child of a parent whose PR reads closed, requeued with its branch kept', () => {
    const actions = run([parentClaim(), childClaim()], { prState: { kind: 'closed', pr: prUrl(10) } })

    expect(releases(actions)).toEqual([
      {
        kind: 'release',
        key: { taskId: 'T-1', slice: 'b' },
        requeue: true,
        reason: 'stack-broken: parent T-1 a #10 closed',
        names: ['bd-t-1-b'],
        branch: 'agent-chat/bd-t-1-b',
      },
    ])
  })

  it('releases a child of a parent that was itself released back to the queue', () => {
    const actions = run([parentClaim({ phase: 'queued', pr: undefined, agentName: undefined }), childClaim()])

    expect(releases(actions).map(a => a.kind === 'release' && a.reason)).toEqual([
      'stack-broken: parent T-1 a #10 released',
    ])
  })

  it('leaves nothing else planned for the released child', () => {
    const planned = childClaim({ phase: 'implementing', stalledReason: undefined })
    const obs = new Map<string, Observation>([
      [claimKey(parentClaim()), { prState: { kind: 'closed', pr: prUrl(10) } }],
      [claimKey(planned), { agent: { id: 'a1', state: 'exited' }, report: parseReport('Status: DONE') }],
    ])
    const alone = advance([planned], new Map([[claimKey(planned), obs.get(claimKey(planned)) ?? {}]]), NOW)
    expect(alone.some(a => a.kind === 'update')).toBe(true)

    const actions = advance([parentClaim(), planned], obs, NOW)

    expect(actions.filter(a => 'key' in a && a.key.slice === 'b').map(a => a.kind)).toEqual(['release'])
  })

  it('retires only the child agents the roster says may still run', () => {
    const child = childClaim({ spawned: ['bd-t-1-b-old'] })
    const obs = new Map<string, Observation>([
      [claimKey(parentClaim()), { prState: { kind: 'closed', pr: prUrl(10) } }],
    ])

    const actions = advance([parentClaim(), child], obs, NOW, name => name === 'bd-t-1-b')

    expect(releases(actions).map(a => a.kind === 'release' && a.names)).toEqual([['bd-t-1-b']])
  })

  it('requeues the child without its stackedOn, so it re-dispatches from the default branch', () => {
    const ledger: Ledger = { version: 1, claims: [parentClaim(), childClaim()] }
    const actions = run(ledger.claims, { prState: { kind: 'closed', pr: prUrl(10) } })

    const after = applyActions(ledger, actions, NOW)

    const child = after.claims.find(c => c.slice === 'b')
    expect(child).toMatchObject({ phase: 'queued', dependsOn: ['a'], owns: ['src/b.ts'] })
    expect(child?.stackedOn).toBeUndefined()
    expect(child?.agentName).toBeUndefined()
    expect(after.ladder?.['T-1#b']?.branch).toBe('agent-chat/bd-t-1-b')
  })

  it('releases nothing for a parent that merged (it is no longer held)', () => {
    const actions = run([childClaim()])

    expect(releases(actions)).toEqual([])
  })

  it('releases nothing for a parent whose PR is still open', () => {
    const actions = run([parentClaim(), childClaim()], { prState: { kind: 'open', pr: prUrl(10) } })

    expect(releases(actions)).toEqual([])
  })

  it('does not touch a claim that is not stacked', () => {
    const actions = run([parentClaim(), childClaim({ stackedOn: undefined })], {
      prState: { kind: 'closed', pr: prUrl(10) },
    })

    expect(releases(actions)).toEqual([])
  })

  describe('the recorded cause', () => {
    const close: Observation = { prState: { kind: 'closed', pr: prUrl(10) } }
    const stale = { respawns: 1, lastAt: AT, code: 'lease-expired' as const, releases: 1 }

    const released = (): { before: Ledger; after: Ledger } => {
      const before: Ledger = {
        version: 1,
        claims: [parentClaim(), childClaim({ seat: 'seat-1' })],
        ladder: { 'T-1#b': stale },
      }
      return { before, after: applyActions(before, run(before.claims, close), NOW) }
    }

    it('stores the reason on the ladder record and drops a carried-over code', () => {
      const { after } = released()

      expect(after.ladder?.['T-1#b']).toMatchObject({ reason: 'stack-broken: parent T-1 a #10 closed' })
      expect(after.ladder?.['T-1#b']?.code).toBeUndefined()
    })

    it('reports the reason, not the old code, in the release the tick logs', () => {
      const { before, after } = released()

      expect(releasesSince(before, after)).toEqual([
        expect.objectContaining({
          taskId: 'T-1',
          slice: 'b',
          reason: 'stack-broken: parent T-1 a #10 closed',
        }),
      ])
      expect(releasesSince(before, after)[0]?.code).toBeUndefined()
    })

    it('tells the seat the reason and no stall code', () => {
      const { before, after } = released()

      const [event] = seatEvents(before, after, [])['seat-1'] ?? []

      expect(event).toMatchObject({
        kind: 'released',
        detail: expect.stringContaining('stack-broken: parent T-1 a #10 closed'),
      })
      expect(event?.detail).not.toContain('lease-expired')
      expect(event?.code).toBeUndefined()
    })

    it('counts as a release, so the child`s next stall goes to the owner rather than a second release', () => {
      const { before, after } = released()

      expect(after.ladder?.['T-1#b']?.releases).toBe((before.ladder?.['T-1#b']?.releases ?? 0) + 1)
      expect(after.releases?.['T-1']?.n).toBe(1)
    })
  })
})
