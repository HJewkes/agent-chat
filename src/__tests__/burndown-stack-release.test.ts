import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Observation } from '../agents/burndown/advance.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'

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
        names: [],
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
    const child = childClaim({ phase: 'reviewing' })
    const actions = advance(
      [parentClaim(), child],
      new Map<string, Observation>([
        [claimKey(parentClaim()), { prState: { kind: 'closed', pr: prUrl(10) } }],
      ]),
      NOW,
    )

    expect(actions.filter(a => 'key' in a && a.key.slice === 'b').map(a => a.kind)).toEqual(['release'])
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
})
