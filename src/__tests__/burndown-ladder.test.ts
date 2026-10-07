import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action } from '../agents/burndown/advance.js'
import { ladderActions, type LadderDeps } from '../agents/burndown/ladder.js'
import { EMPTY_LEDGER, readLedger, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { seatEvents } from '../agents/burndown/seat-events.js'
import { loadTickConfig } from '../agents/burndown/source.js'

/** The triage ladder (CC-660 E1) over hand-built claims; no broker, git or transcript. */

const NOW = new Date('2026-10-05T12:00:00.000Z')
const FIRST_PHASE = '2026-10-05T06:00:00.000Z'
const SECOND_PHASE = '2026-10-05T07:00:00.000Z'
const KEY = 'CC-1#'
const DIFF = ' src/a.ts | 4 ++--\n 1 file changed\nuncommitted:\n M src/b.ts'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  worktree: '/repo/.worktrees/bd-cc-1',
  spawnedAt: FIRST_PHASE,
  phase: 'implementing',
  phaseAt: FIRST_PHASE,
  seat: 'alpha',
  ...patch,
})

const deps = (over: Partial<LadderDeps> = {}): LadderDeps => ({
  enabled: true,
  diffSummary: () => DIFF,
  live: () => true,
  now: NOW,
  ...over,
})

/** The claim's phase-timeout stall, as `advance` writes it four hours into the phase. */
const timedOut = (c: Claim): Action[] => advance([c], new Map(), NOW)

function ladder(c: Claim, ledger: Ledger, actions: Action[], over: Partial<LadderDeps> = {}) {
  const out = ladderActions(actions, [c], ledger, deps(over))
  return { ...out, after: applyActions(ledger, out.actions, NOW) }
}

const withClaim = (c: Claim, rest: Partial<Ledger> = {}): Ledger => ({
  ...EMPTY_LEDGER,
  claims: [c],
  ...rest,
})

const respawned = (occurrence: string): NonNullable<Ledger['ladder']> => ({
  [KEY]: { respawns: 1, lastAt: '2026-10-05T10:00:00.000Z', occurrence },
})

const kinds = (actions: Action[]): string[] => actions.map(a => a.kind)

describe('ladderActions rung 1', () => {
  it('marks a first phase-timeout stall and retires its agents newest first, without counting a respawn yet', () => {
    const c = claim({ spawned: ['bd-cc-1', 'bd-cc-1-s1'], attempt: 1 })

    const { actions, after } = ladder(c, withClaim(c), timedOut(c))

    expect(kinds(actions)).not.toContain('spawn')
    expect(actions.find(a => a.kind === 'retire')).toMatchObject({
      names: ['bd-cc-1-s1', 'bd-cc-1'],
      held: true,
    })
    expect(after.claims[0]).toMatchObject({ respawn: { code: 'phase-timeout', occurrence: FIRST_PHASE } })
    expect(after.claims[0]?.stalledReason).toBeUndefined()
    expect(after.ladder?.[KEY]).toMatchObject({ respawns: 0, occurrence: FIRST_PHASE })
  })

  it('spawns the stall successor on a later tick once every agent is retired, clearing the mark', () => {
    const c = claim({ attempt: 1, respawn: { code: 'phase-timeout', occurrence: FIRST_PHASE } })

    const { actions, after } = ladder(c, withClaim(c), [], { live: () => false })

    expect(kinds(actions)).toEqual(['update', 'spawn'])
    expect(actions[1]).toMatchObject({
      role: 'successor',
      context: { kind: 'stall', code: 'phase-timeout', diffSummary: DIFF },
    })
    expect(after.claims[0]).toMatchObject({ phase: 'spawning', attempt: 2 })
    expect(after.claims[0]?.respawn).toBeUndefined()
  })

  it('retries the retire and holds the spawn while an agent is still live', () => {
    const c = claim({
      spawned: ['bd-cc-1', 'bd-cc-1-s1'],
      respawn: { code: 'phase-timeout', occurrence: FIRST_PHASE },
    })

    const { actions } = ladder(c, withClaim(c), [], { live: name => name === 'bd-cc-1' })

    expect(actions).toEqual([{ kind: 'retire', key: { taskId: 'CC-1' }, names: ['bd-cc-1'], held: true }])
  })

  it('ignores attempt and reviewRound when choosing the rung', () => {
    const c = claim({ attempt: 2, reviewRound: 1 })

    const { after } = ladder(c, withClaim(c), timedOut(c))

    expect(after.claims[0]?.respawn).toMatchObject({ code: 'phase-timeout' })
    expect(after.claims[0]?.stalledReason).toBeUndefined()
  })

  it('counts the respawn once the successor has moved the claim to a new phase', () => {
    const c = claim({ phase: 'spawning', phaseAt: SECOND_PHASE })
    const ledger = withClaim(c, {
      ladder: { [KEY]: { respawns: 0, lastAt: NOW.toISOString(), occurrence: FIRST_PHASE } },
    })

    const { after } = ladder(c, ledger, [])

    expect(after.ladder?.[KEY]).toMatchObject({ respawns: 1, occurrence: FIRST_PHASE })
  })

  it('marks the claim on a lease-expired finding', () => {
    const c = claim()
    const finding = {
      kind: 'stalled-after-claim' as const,
      reason: 'lease' as const,
      code: 'lease-expired' as const,
      since: FIRST_PHASE,
      openedAt: NOW.toISOString(),
      checkedAt: NOW.toISOString(),
      detail: 'lease-expired: lease: no commit for 40 min',
    }
    const update: Action = { kind: 'update', key: { taskId: 'CC-1' }, patch: { finding } }

    const { after } = ladder(c, withClaim(c), [update])

    expect(after.claims[0]?.respawn).toMatchObject({ code: 'lease-expired' })
  })
})

describe('ladderActions rung 3', () => {
  it('stalls a second occurrence for the owner once, with its code and one stalled notice', () => {
    const c = claim({
      phaseAt: SECOND_PHASE,
      attempt: 1,
      spawned: ['bd-cc-1', 'bd-cc-1-s1'],
      notified: ['dispatched'],
    })
    const before = withClaim(c, { ladder: respawned(FIRST_PHASE) })

    const { actions, after } = ladder(c, before, timedOut(c))

    expect(kinds(actions)).not.toContain('spawn')
    expect(after.claims[0]).toMatchObject({ stalledClass: 'stalled', stallCode: 'phase-timeout' })
    expect(after.claims[0]?.stalledReason).toMatch(/^phase-timeout: ladder exhausted/)
    expect(after.ladder?.[KEY]).toMatchObject({ respawns: 1, owner: NOW.toISOString() })
    expect((seatEvents(before, after, []).alpha ?? []).map(e => e.kind)).toEqual(['stalled'])
  })
})

describe('ladderActions without a worktree', () => {
  it('stalls a first occurrence for the owner and says no respawn could adopt it', () => {
    const c = claim({ worktree: undefined })

    const { after } = ladder(c, withClaim(c), timedOut(c))

    expect(after.claims[0]?.stalledReason).toBe('phase-timeout: no worktree for a respawn to adopt')
    expect(after.ladder?.[KEY]).toMatchObject({ respawns: 0 })
  })
})

describe('ladderActions leaves non-ladder stalls alone', () => {
  it('takes no action on a CC-653 idle finding', () => {
    const c = claim()
    const finding = {
      kind: 'stalled-after-claim' as const,
      reason: 'idle' as const,
      code: 'no-progress' as const,
      since: FIRST_PHASE,
      openedAt: NOW.toISOString(),
      checkedAt: NOW.toISOString(),
      detail: 'no-progress: idle: no agent event for 6 min',
    }
    const actions: Action[] = [{ kind: 'update', key: { taskId: 'CC-1' }, patch: { finding } }]

    const out = ladder(c, withClaim(c), actions)

    expect(out.actions).toEqual(actions)
    expect(out.after.ladder).toBeUndefined()
  })

  it('takes no action on a shepherd-ended stall', () => {
    const c = claim({ phase: 'shepherding', pr: 'https://github.com/o/r/pull/9' })
    const actions: Action[] = [
      {
        kind: 'update',
        key: { taskId: 'CC-1' },
        patch: {
          stalledReason: 'Shepherd run r ended failed',
          stalledClass: 'failed',
          stallCode: 'shepherd-ended',
        },
      },
    ]

    const out = ladder(c, withClaim(c), actions)

    expect(out.actions).toEqual(actions)
    expect(out.notes).toEqual([])
  })
})

describe('ladderActions with ladder.enabled false', () => {
  it('is the default when the burndown config does not name it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-config-'))
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ enabled: true }))

    expect(loadTickConfig(file).ladder.enabled).toBe(false)
  })

  it('keeps the stall and writes one would-respawn line for a first occurrence', () => {
    const c = claim()
    const stall = timedOut(c)
    let read = 0

    const out = ladder(c, withClaim(c), stall, {
      enabled: false,
      diffSummary: () => {
        read += 1
        return DIFF
      },
    })

    expect(out.actions).toEqual(stall)
    expect(out.notes).toEqual([`ladder off: would respawn ${KEY} (phase-timeout)`])
    expect(out.after.ladder).toBeUndefined()
    expect(read).toBe(0)
  })

  it('writes one would-stall-owner line for a second occurrence', () => {
    const c = claim({ phaseAt: SECOND_PHASE })
    const stall = timedOut(c)

    const out = ladder(c, withClaim(c, { ladder: respawned(FIRST_PHASE) }), stall, { enabled: false })

    expect(out.actions).toEqual(stall)
    expect(out.notes).toEqual([`ladder off: would stall-owner ${KEY} (phase-timeout)`])
  })
})

describe('a respawn under way when the ladder is turned off', () => {
  it('goes to the owner rather than waiting on the ladder', () => {
    const c = claim({ respawn: { code: 'phase-timeout', occurrence: FIRST_PHASE } })

    const { actions, after } = ladder(c, withClaim(c), [], { enabled: false })

    expect(kinds(actions)).not.toContain('spawn')
    expect(after.claims[0]).toMatchObject({ stallCode: 'phase-timeout', stalledClass: 'stalled' })
    expect(after.claims[0]?.respawn).toBeUndefined()
  })
})

describe('the ladder record', () => {
  it('survives writeLedger and readLedger', () => {
    const c = claim()
    const { after } = ladder(c, withClaim(c), timedOut(c))
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-')), 'ledger.json')

    writeLedger(file, after)

    expect(readLedger(file).ladder).toEqual(after.ladder)
    expect(claimKey(c)).toBe(KEY)
  })
})
