import { describe, expect, it } from 'vitest'
import type { Observation } from '../agents/burndown/advance.js'
import { findingActions } from '../agents/burndown/finding.js'
import { LEASE_MS, MAX_RENEWALS, leaseStep, type Lease } from '../agents/burndown/lease.js'
import type { Claim } from '../agents/burndown/ledger.js'
import type { Progress } from '../agents/burndown/progress.js'

const MIN = 60_000
const T0 = Date.parse('2026-10-03T10:00:00.000Z')
const UNTIL = T0 + LEASE_MS
const iso = (ms: number): string => new Date(ms).toISOString()

const progress = (over: Partial<Progress> = {}): Progress => ({
  head: 'h1',
  dirty: 'd1',
  dirtyCount: 0,
  content: 'c1',
  ...over,
})

const lease = (over: Partial<Lease> = {}): Lease => ({
  progressAt: iso(T0),
  leaseUntil: iso(UNTIL),
  renewals: 0,
  head: 'h1',
  content: 'c1',
  transcriptAt: iso(T0),
  ...over,
})

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  spawnedAt: iso(T0),
  phase: 'implementing',
  phaseAt: iso(T0),
  agentName: 'bd-cc-1',
  worktree: '/repo/.worktrees/bd-cc-1',
  lease: lease(),
  ...over,
})

const transcriptAt = (ms: number) => ({ read: { lastAt: iso(ms) }, spawnedAt: T0 })

const step = (c: Claim, obs: Observation, now: number, parked = false) =>
  leaseStep(c, obs, { parked, now: new Date(now) })

const findingOf = (c: Claim, obs: Observation, now: number) =>
  findingActions([c], new Map([['CC-1#', obs]]), new Set(), new Date(now))[0]?.patch.finding

describe('renewing a lease on a commit', () => {
  it('renews a lease 10 min past its end and resets the renewals', () => {
    const now = T0 + 40 * MIN

    const result = step(claim({ lease: lease({ renewals: 3 }) }), { progress: progress({ head: 'h2' }) }, now)

    expect(result).toEqual({
      lease: expect.objectContaining({
        progressAt: iso(now),
        leaseUntil: iso(now + LEASE_MS),
        renewals: 0,
        head: 'h2',
      }),
    })
  })

  it('closes a lease finding once the head moves', () => {
    const now = T0 + 45 * MIN
    const expired = claim()
    const opened = findingOf(expired, { progress: progress() }, now)

    const after = findingOf({ ...expired, finding: opened }, { progress: progress({ head: 'h2' }) }, now)

    expect(opened).toMatchObject({ reason: 'lease', code: 'lease-expired' })
    expect(after).toBeUndefined()
  })
})

describe('renewing a lease on other evidence only before it ends', () => {
  const edited = { progress: progress({ content: 'c2', dirtyCount: 1 }) }
  const talked = { progress: progress(), activity: transcriptAt(UNTIL - 2 * MIN) }

  it.each([
    { what: 'an edit', obs: edited, offset: -1, renews: true, verdict: undefined },
    { what: 'an edit', obs: edited, offset: 0, renews: true, verdict: undefined },
    { what: 'an edit', obs: edited, offset: 1, renews: false, verdict: 'dirty-uncommitted' },
    { what: 'transcript progress', obs: talked, offset: -1, renews: true, verdict: undefined },
    { what: 'transcript progress', obs: talked, offset: 1, renews: false, verdict: 'lease-expired' },
  ] as const)('$what at leaseUntil $offset ms renews: $renews', ({ obs, offset, renews, verdict }) => {
    const result = step(claim(), obs, UNTIL + offset)

    expect(result.verdict).toBe(verdict)
    expect(result.lease?.renewals).toBe(renews ? 1 : 0)
    expect(result.lease?.leaseUntil).toBe(iso(renews ? UNTIL + LEASE_MS : UNTIL))
  })

  it('renews while a Bash call younger than its tool limit is still open', () => {
    const verify = {
      read: { lastAt: iso(T0), pending: { tool: 'Bash', at: iso(UNTIL - 5 * MIN) } },
      spawnedAt: T0,
    }

    expect(step(claim(), { progress: progress(), activity: verify }, UNTIL - 1).lease?.renewals).toBe(1)
  })
})

describe('an ended lease', () => {
  it('opens a lease-expired finding 10 min past the lease on the next tick', () => {
    const now = UNTIL + 10 * MIN

    const finding = findingOf(claim(), { progress: progress(), activity: transcriptAt(now - MIN) }, now)

    expect(finding).toMatchObject({ reason: 'lease', code: 'lease-expired', since: iso(T0) })
    expect(finding?.detail).toBe(`lease-expired: lease: no commit for 40 min since ${iso(T0)}`)
  })

  it('gives no verdict and keeps the lease when the worktree cannot be read', () => {
    const held = claim()

    const result = step(held, { progress: 'unreadable' }, UNTIL + 10 * MIN)

    expect(result.verdict).toBeUndefined()
    expect(result.lease).toBe(held.lease)
  })

  it('keeps an open lease finding while the worktree cannot be read', () => {
    const now = UNTIL + 10 * MIN
    const opened = findingOf(claim(), { progress: progress() }, now)
    const held = claim({ finding: opened })

    expect(
      findingActions([held], new Map([['CC-1#', { progress: 'unreadable' }]]), new Set(), new Date(now)),
    ).toEqual([])
  })
})

describe('a parked pool', () => {
  it('extends the lease without a renewal or a verdict', () => {
    const now = UNTIL + 60 * MIN

    const result = step(claim({ lease: lease({ renewals: 2 }) }), { progress: progress() }, now, true)

    expect(result.verdict).toBeUndefined()
    expect(result.lease).toMatchObject({ renewals: 2, leaseUntil: iso(now + LEASE_MS) })
  })
})

describe('the renewal cap', () => {
  it('gives no-progress on the renewal past the cap when only the transcript grows', () => {
    let held = claim({ lease: undefined })
    const seen: { renewals: number; verdict: string | undefined }[] = []

    for (let now = T0 + 10 * MIN; seen.length < 20 && seen.at(-1)?.verdict === undefined; now += 10 * MIN) {
      const result = step(held, { progress: progress(), activity: transcriptAt(now - MIN) }, now)
      held = { ...held, lease: result.lease }
      seen.push({ renewals: result.lease?.renewals ?? -1, verdict: result.verdict })
    }

    expect(seen.at(-1)).toEqual({ renewals: MAX_RENEWALS + 1, verdict: 'no-progress' })
    expect(seen.slice(0, -1).every(s => s.verdict === undefined && s.renewals <= MAX_RENEWALS)).toBe(true)
    expect(seen.length).toBeGreaterThan(MAX_RENEWALS * 2)
  })
})

describe('a fresh claim', () => {
  it('starts a lease from the phase start and never stalls within it', () => {
    const now = T0 + 20 * MIN
    const fresh = claim({ lease: undefined })
    const obs = { progress: progress(), activity: transcriptAt(now - MIN) }

    const result = step(fresh, obs, now)

    expect(result.verdict).toBeUndefined()
    expect(result.lease).toMatchObject({ progressAt: iso(T0), leaseUntil: iso(UNTIL), renewals: 0 })
    expect(findingOf(fresh, obs, now)).toBeUndefined()
  })

  it('holds no lease outside implementing or without a worktree', () => {
    expect(step(claim({ phase: 'reviewing' }), { progress: progress() }, T0)).toEqual({})
    expect(step(claim({ worktree: undefined }), { progress: progress() }, T0)).toEqual({})
  })

  it('restarts a lease held before a park, an answer and a successor', () => {
    const dirty = { progress: progress({ dirtyCount: 1 }) }
    const tick = (c: Claim, now: number): Claim => {
      const patch = findingActions([c], new Map([['CC-1#', dirty]]), new Set(), new Date(now))[0]?.patch
      return { ...c, ...patch }
    }
    const expired = tick(tick(claim({ lease: undefined }), T0 + 5 * MIN), UNTIL + 10 * MIN)
    const parked = tick({ ...expired, phase: 'parked', phaseAt: iso(UNTIL + 15 * MIN) }, UNTIL + 20 * MIN)
    const resumedAt = UNTIL + 60 * MIN
    const resumed = { ...parked, phase: 'implementing' as const, phaseAt: iso(resumedAt) }

    const after = tick(resumed, resumedAt + 5 * MIN)

    expect(expired.finding?.code).toBe('dirty-uncommitted')
    expect(parked.lease).toEqual(expired.lease)
    expect(step(resumed, dirty, resumedAt + 5 * MIN).verdict).toBeUndefined()
    expect(after.finding).toBeUndefined()
    expect(after.lease).toMatchObject({ progressAt: iso(resumedAt), leaseUntil: iso(resumedAt + LEASE_MS) })
  })
})

describe('a claim first seen more than a window into its phase', () => {
  const now = T0 + 120 * MIN
  const old = claim({ lease: undefined })

  it('gives no verdict on the first tick and one full window from then', () => {
    const result = step(old, { progress: progress() }, now)

    expect(result.verdict).toBeUndefined()
    expect(result.lease).toMatchObject({ progressAt: iso(T0), leaseUntil: iso(now + LEASE_MS) })
  })

  it('gives lease-expired 10 min past that window', () => {
    const first = step(old, { progress: progress() }, now)

    const later = step({ ...old, lease: first.lease }, { progress: progress() }, now + LEASE_MS + 10 * MIN)

    expect(later.verdict).toBe('lease-expired')
  })
})
