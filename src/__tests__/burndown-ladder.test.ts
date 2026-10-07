import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action } from '../agents/burndown/advance.js'
import { execute } from '../agents/burndown/execute.js'
import { orphanRefusal } from '../agents/burndown/plan.js'
import { stepsForActions, type StepContext } from '../agents/burndown/steps.js'
import { ladderActions, type LadderDeps } from '../agents/burndown/ladder.js'
import { EMPTY_LEDGER, readLedger, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { deliverSeatEvents } from '../agents/burndown/seat-deliver.js'
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

const releasedBefore = (occurrence: string): NonNullable<Ledger['ladder']> => ({
  [KEY]: { ...(respawned(occurrence)[KEY] as NonNullable<Ledger['ladder']>[string]), releases: 1 },
})

const LIVENESS: NonNullable<Ledger['liveness']> = {
  'CC-1#|retire:bd-cc-1': {
    byFact: { f: { n: 2, firstAt: FIRST_PHASE, lastAt: SECOND_PHASE, lastText: 'busy' } },
  },
}

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

describe('ladderActions rung 2 (CC-698)', () => {
  const second = (): { c: Claim; before: Ledger } => {
    const c = claim({ phaseAt: SECOND_PHASE, attempt: 1, spawned: ['bd-cc-1', 'bd-cc-1-s1'] })
    return { c, before: withClaim(c, { ladder: respawned(FIRST_PHASE), liveness: LIVENESS }) }
  }

  it('releases a second occurrence: the whole-task claim is dropped, the branch named, liveness kept', () => {
    const { c, before } = second()

    const { actions, after } = ladder(c, before, timedOut(c), { branch: () => 'agent/cc-1' })

    expect(actions).toEqual([
      {
        kind: 'release',
        key: { taskId: 'CC-1' },
        requeue: false,
        code: 'phase-timeout',
        names: ['bd-cc-1-s1', 'bd-cc-1'],
        branch: 'agent/cc-1',
      },
    ])
    expect(after.claims).toEqual([])
    expect(after.ladder?.[KEY]).toMatchObject({
      respawns: 1,
      releases: 1,
      branch: 'agent/cc-1',
      seat: 'alpha',
    })
    expect(after.releases?.['CC-1']).toMatchObject({ n: 1 })
    expect(after.liveness).toEqual(LIVENESS)
  })

  it('retires only the agents that may still run, so a predecessor rung 1 retired is not asked again', () => {
    const { c, before } = second()

    const { actions } = ladder(c, before, timedOut(c), { live: name => name === 'bd-cc-1-s1' })

    expect(actions[0]).toMatchObject({ kind: 'release', names: ['bd-cc-1-s1'] })
  })

  it('sends a released slice claim back to queued, with its slice fields and no agent fields', () => {
    const c = claim({ slice: 'a', dependsOn: ['b'], owns: ['src/a.ts'], phaseAt: SECOND_PHASE, pr: 'u' })
    const key = 'CC-1#a'
    const before = withClaim(c, { ladder: { [key]: { ...respawned(FIRST_PHASE)[KEY]!, releases: 0 } } })

    const { after } = ladder(c, before, timedOut(c), { branch: () => 'agent/cc-1-a' })

    expect(after.claims).toEqual([
      {
        taskId: 'CC-1',
        initiative: 'demo',
        spawnedAt: FIRST_PHASE,
        phase: 'queued',
        phaseAt: NOW.toISOString(),
        slice: 'a',
        dependsOn: ['b'],
        owns: ['src/a.ts'],
        seat: 'alpha',
      },
    ])
    expect(after.ladder?.[key]).toMatchObject({ releases: 1, branch: 'agent/cc-1-a' })
  })

  it('tells the seat once, naming the branch', () => {
    const { c, before } = second()

    const { after } = ladder(c, before, timedOut(c), { branch: () => 'agent/cc-1' })

    const events = seatEvents(before, after, []).alpha ?? []
    expect(events).toMatchObject([
      { kind: 'released', taskId: 'CC-1', detail: expect.stringContaining('agent/cc-1') },
    ])
    expect(seatEvents(after, after, []).alpha ?? []).toEqual([])
  })

  describe('a released notice whose delivery failed (CC-829)', () => {
    const deliver = async (before: Ledger, after: Ledger, ok: boolean) => {
      const sent: string[] = []
      const send = async (_: string, text: string) => (sent.push(text), { ok, reason: 'socket closed' })
      const open = async () => ({ send, notify: async () => ({ ok }), close: () => {} })
      const told = await deliverSeatEvents(
        { seats: ['alpha'], before, after, spawns: [] },
        { open, log: () => {}, now: NOW },
      )
      return { ledger: told.ledger, released: sent.filter(t => t.includes('\nreleased CC-1')) }
    }
    const releasedOnce = (): { before: Ledger; after: Ledger } => {
      const { c, before } = second()
      return { before, after: ladder(c, before, timedOut(c), { branch: () => 'agent/cc-1' }).after }
    }

    it('is sent again on the next tick, then not again once it lands', async () => {
      const { before, after } = releasedOnce()

      const failed = await deliver(before, after, false)
      const retried = await deliver(failed.ledger, failed.ledger, true)
      const third = await deliver(retried.ledger, retried.ledger, true)

      expect(failed.released).toHaveLength(1)
      expect(retried.released).toEqual([expect.stringContaining('agent/cc-1')])
      expect(third.released).toEqual([])
    })

    it('is not sent twice when the first delivery landed', async () => {
      const { before, after } = releasedOnce()

      const landed = await deliver(before, after, true)
      const next = await deliver(landed.ledger, landed.ledger, true)

      expect(landed.released).toHaveLength(1)
      expect(next.released).toEqual([])
    })
  })

  it('releases once per key: with no worktree to adopt, the first occurrence still goes to the owner', () => {
    const c = claim({ worktree: undefined })

    const { after } = ladder(c, withClaim(c), timedOut(c))

    expect(after.claims[0]?.stalledReason).toBeDefined()
    expect(after.ladder?.[KEY]?.releases).toBeUndefined()
  })
})

describe('a refused retire under a release (CC-698)', () => {
  const refuse = async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'worktree busy' })

  it.each([
    ['whole-task', undefined],
    ['slice', 'a'],
  ])(
    'keeps the %s claim held and live, spends the budget, and parks retry-spent on the third refusal',
    async (_, slice) => {
      const c = claim({ slice, phaseAt: SECOND_PHASE })
      const key = `CC-1#${slice ?? ''}`
      const release: Action = {
        kind: 'release',
        key: { taskId: 'CC-1', slice },
        requeue: slice !== undefined,
        code: 'phase-timeout',
        names: ['bd-cc-1'],
      }
      let ledger = withClaim(c, { liveness: LIVENESS })
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-retire-')), 'ledger.json')

      const afterOne = await runRelease(ledger, release, file)
      ledger = afterOne
      ledger = await runRelease(ledger, release, file)
      const afterThree = await runRelease(ledger, release, file)

      expect(afterOne.claims).toMatchObject([
        {
          phase: 'implementing',
          unretired: expect.arrayContaining([expect.objectContaining({ name: 'bd-cc-1' })]),
        },
      ])
      expect(afterOne.releases).toBeUndefined()
      expect(afterOne.ladder).toBeUndefined()
      expect(afterOne.liveness?.[`${key}|retire:bd-cc-1`]).toBeDefined()
      expect(afterThree.claims[0]).toMatchObject({ stallCode: 'retry-spent', phase: 'implementing' })
      expect(afterThree.releases).toBeUndefined()
    },
  )

  it('records only the refused agent when another retired, and does not release', async () => {
    const c = claim({ spawned: ['bd-cc-1', 'bd-cc-1-s1'], phaseAt: SECOND_PHASE })
    const release: Action = {
      kind: 'release',
      key: { taskId: 'CC-1' },
      requeue: false,
      code: 'phase-timeout',
      names: ['bd-cc-1-s1', 'bd-cc-1'],
    }
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-retire-')), 'ledger.json')

    const after = await runRelease(withClaim(c), release, file, async name =>
      name === 'bd-cc-1-s1' ? { ok: true } : { ok: false, reason: 'worktree busy' },
    )

    expect(after.claims).toMatchObject([{ phase: 'implementing' }])
    expect(after.claims[0]?.unretired).toMatchObject([{ name: 'bd-cc-1', reason: 'worktree busy' }])
    expect(after.releases).toBeUndefined()
  })

  async function runRelease(
    ledger: Ledger,
    release: Action,
    file: string,
    retire: (name: string) => Promise<{ ok: boolean; reason?: string }> = refuse,
  ): Promise<Ledger> {
    const { steps } = stepsForActions([release], ledger, {} as StepContext, 0)
    const done = await execute(steps, ledger, {
      ledgerFile: file,
      spawn: async () => ({ ok: true }),
      retire,
      register: () => ({ ok: true }) as never,
      prHead: () => undefined,
      log: () => {},
      now: NOW,
    })
    return done.ledger
  }
})

describe('the orphan check and a released branch (CC-698)', () => {
  const exists = (): string => 'branch agent-chat/bd-cc-1 already exist with no ledger claim'
  const at = { initiative: 'demo', repo: '/repo' }

  it('refuses a branch no ledger record explains', () => {
    expect(orphanRefusal(at, 'CC-1', 'bd-implementer', exists, EMPTY_LEDGER)).toMatchObject({
      kind: 'orphan',
    })
  })

  it('lets the branch a release kept be adopted by the re-dispatch', () => {
    const ledger = {
      ...EMPTY_LEDGER,
      ladder: {
        [KEY]: { respawns: 1, releases: 1, lastAt: NOW.toISOString(), branch: 'agent-chat/bd-cc-1' },
      },
    }

    expect(orphanRefusal(at, 'CC-1', 'bd-implementer', exists, ledger)).toBeUndefined()
  })

  it('still refuses when the recorded branch is another one', () => {
    const ledger = {
      ...EMPTY_LEDGER,
      ladder: { [KEY]: { respawns: 1, releases: 1, lastAt: NOW.toISOString(), branch: 'agent-chat/other' } },
    }

    expect(orphanRefusal(at, 'CC-1', 'bd-implementer', exists, ledger)).toMatchObject({ kind: 'orphan' })
  })
})

describe('a ladder record when its claim finishes (CC-829)', () => {
  const exists = (): string => 'branch agent-chat/bd-cc-1 already exist with no ledger claim'
  const at = { initiative: 'demo', repo: '/repo' }
  const finished = (): { c: Claim; before: Ledger; done: Action[] } => {
    const c = claim({ phase: 'shepherding', pr: 'https://github.com/o/r/pull/9' })
    const ladder = { [KEY]: { ...releasedBefore(FIRST_PHASE)[KEY]!, branch: 'agent-chat/bd-cc-1' } }
    return {
      c,
      before: withClaim(c, { ladder }),
      done: [{ kind: 'update', key: { taskId: 'CC-1' }, patch: { phase: 'done' } }],
    }
  }

  it('is pruned on the move to done, so a re-opened task does not adopt the old branch', () => {
    const { c, before, done } = finished()

    const { after } = ladder(c, before, done)

    expect(after.claims[0]?.phase).toBe('done')
    expect(after.ladder?.[KEY]).toBeUndefined()
    expect(orphanRefusal(at, 'CC-1', 'bd-implementer', exists, after)).toMatchObject({ kind: 'orphan' })
  })

  it('is kept with the ladder off', () => {
    const { c, before, done } = finished()

    const { actions, after } = ladder(c, before, done, { enabled: false })

    expect(actions).toEqual(done)
    expect(after.ladder).toEqual(before.ladder)
  })
})

describe('ladderActions rung 3', () => {
  it('stalls a third occurrence for the owner once, with its code and one stalled notice', () => {
    const c = claim({
      phaseAt: SECOND_PHASE,
      attempt: 1,
      spawned: ['bd-cc-1', 'bd-cc-1-s1'],
      notified: ['dispatched'],
    })
    const before = withClaim(c, { ladder: releasedBefore(FIRST_PHASE) })

    const { actions, after } = ladder(c, before, timedOut(c))

    expect(kinds(actions)).not.toContain('spawn')
    expect(after.claims[0]).toMatchObject({ stalledClass: 'stalled', stallCode: 'phase-timeout' })
    expect(after.claims[0]?.stalledReason).toMatch(/^phase-timeout: ladder exhausted/)
    expect(after.ladder?.[KEY]).toMatchObject({ respawns: 1, releases: 1, owner: NOW.toISOString() })
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

  it('writes one would-stall-owner line for a third occurrence', () => {
    const c = claim({ phaseAt: SECOND_PHASE })
    const stall = timedOut(c)

    const out = ladder(c, withClaim(c, { ladder: releasedBefore(FIRST_PHASE) }), stall, { enabled: false })

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

describe('the brake (CC-699)', () => {
  const MIN = 60_000
  const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * MIN).toISOString()
  const trio = (): Claim[] =>
    ['CC-1', 'CC-2', 'CC-3'].map(id => {
      const name = `bd-${id.toLowerCase()}`
      return claim({ taskId: id, agentName: name, spawned: [name], worktree: `/repo/.worktrees/${name}` })
    })
  const tick = (claims: Claim[], ledger: Ledger, over: Partial<LadderDeps> = {}) => {
    const out = ladderActions(advance(claims, new Map(), NOW), claims, ledger, deps(over))
    return { ...out, after: applyActions(ledger, [...out.actions, ...out.brake], NOW) }
  }
  const brakeEvents = (before: Ledger, after: Ledger) =>
    Object.values(seatEvents(before, after, [])).flatMap(es => es.filter(e => e.kind === 'brake'))
  const braked = (minutesAgo: number): Ledger['brake'] => ({
    at: [ago(minutesAgo), ago(minutesAgo), ago(minutesAgo)],
    notified: 'brake:phase-timeout',
    claims: ['CC-7#', 'CC-8#', 'CC-9#'],
  })

  it('gives three stalls in one tick one brake notice and no respawn or release', () => {
    const claims = trio()
    const before: Ledger = { ...EMPTY_LEDGER, claims }

    const { actions, after } = tick(claims, before)

    expect(kinds(actions).filter(k => ['spawn', 'retire', 'release', 'ladder'].includes(k))).toEqual([])
    expect(after.claims.map(c => c.respawn)).toEqual([undefined, undefined, undefined])
    expect(after.claims.map(c => c.stallCode)).toEqual(['phase-timeout', 'phase-timeout', 'phase-timeout'])
    expect(after.ladder).toBeUndefined()
    expect(after.brake).toMatchObject({ at: [NOW.toISOString(), NOW.toISOString(), NOW.toISOString()] })
    expect(brakeEvents(before, after)).toEqual([
      {
        kind: 'brake',
        taskId: 'CC-1, CC-2, CC-3',
        code: 'phase-timeout',
        detail: expect.stringMatching(/^phase-timeout: 3 ladder stalls in 30 min/),
      },
    ])
  })

  it('tells the seat of a respawn the brake holds, not only the seats of this tick’s stalls (CC-829)', () => {
    const [, two, three] = trio() as [Claim, Claim, Claim]
    const respawning = claim({ seat: 'beta', respawn: { code: 'phase-timeout', occurrence: FIRST_PHASE } })
    const claims = [respawning, two, three]
    const before: Ledger = {
      ...EMPTY_LEDGER,
      claims,
      ladder: { [KEY]: { respawns: 0, lastAt: ago(10), occurrence: FIRST_PHASE } },
      brake: { at: [ago(10)], seen: [`${KEY}@${FIRST_PHASE}`] },
    }

    const { actions, after } = tick(claims, before, { live: () => false })

    expect(kinds(actions)).not.toContain('spawn')
    expect(after.brake?.claims).toEqual(['CC-1#', 'CC-2#', 'CC-3#'])
    expect((seatEvents(before, after, []).beta ?? []).filter(e => e.kind === 'brake')).toEqual([
      expect.objectContaining({ kind: 'brake', taskId: 'CC-1', code: 'phase-timeout' }),
    ])
  })

  it('stays braked across a ledger re-read inside the window, with no second notice', () => {
    const c = claim()
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brake-')), 'ledger.json')
    writeLedger(file, withClaim(c, { brake: braked(20) }))
    const before = readLedger(file)

    const { actions, after } = tick([c], before)

    expect(kinds(actions).filter(k => ['spawn', 'retire', 'release', 'ladder'].includes(k))).toEqual([])
    expect(after.claims[0]?.respawn).toBeUndefined()
    expect(after.brake?.at).toHaveLength(4)
    expect(after.brake?.notified).toBe('brake:phase-timeout')
    expect(brakeEvents(before, after)).toEqual([])
  })

  it('gives a new occurrence rung 1 once the window has cleared, forgetting the old times and notice', () => {
    const claims = trio()
    const first = tick(claims, { ...EMPTY_LEDGER, claims }).after
    const fourth = claim({ taskId: 'CC-4', worktree: '/repo/.worktrees/bd-cc-4' })
    const later = new Date(NOW.getTime() + 31 * MIN)

    const out = ladderActions(advance([fourth], new Map(), later), [fourth], first, deps({ now: later }))
    const after = applyActions(
      { ...first, claims: [...first.claims, fourth] },
      [...out.actions, ...out.brake],
      later,
    )

    expect(first.brake?.at).toHaveLength(3)
    expect(out.actions.find(a => a.kind === 'retire')).toMatchObject({ key: { taskId: 'CC-4' }, held: true })
    expect(after.claims[3]?.respawn).toMatchObject({ code: 'phase-timeout' })
    expect(after.brake).toEqual({ at: [later.toISOString()], seen: [`CC-4#@${FIRST_PHASE}`] })
  })

  it('counts a release retried on later ticks as one occurrence, so it never brakes itself', () => {
    const c = claim({ phaseAt: SECOND_PHASE, spawned: ['bd-cc-1', 'bd-cc-1-s1'] })
    let ledger = withClaim(c, { ladder: respawned(FIRST_PHASE) })

    for (const _ of [1, 2, 3]) ledger = applyActions(ledger, tick([c], ledger).brake, NOW)
    const fourth = tick([c], ledger)

    expect(ledger.brake?.at).toHaveLength(1)
    expect(kinds(fourth.actions)).toEqual(['release'])
  })

  it('still stalls a claim past rung 2 for its owner while braked, and holds a first occurrence beside it', () => {
    const c = claim({ phaseAt: SECOND_PHASE })
    const [, other] = trio() as [Claim, Claim]
    const before: Ledger = {
      ...EMPTY_LEDGER,
      claims: [c, other],
      ladder: releasedBefore(FIRST_PHASE),
      brake: braked(10),
    }

    const { actions, after } = tick([c, other], before)

    expect(after.claims[0]?.stalledReason).toMatch(/^phase-timeout: ladder exhausted/)
    expect(after.ladder?.[KEY]).toMatchObject({ releases: 1, owner: NOW.toISOString() })
    expect(after.ladder?.['CC-2#']).toBeUndefined()
    expect(kinds(actions)).not.toContain('retire')
    expect(after.brake?.at).toHaveLength(4)
  })

  it('does not count a braked occurrence toward the claim, so its next one after the window is rung 1', () => {
    const c = claim()
    const first = tick([c], withClaim(c, { brake: braked(10) })).after
    const cleared: Claim = {
      ...(first.claims[0] as Claim),
      stalledReason: undefined,
      stalledClass: undefined,
      stallCode: undefined,
      phaseAt: SECOND_PHASE,
    }
    const later = new Date(NOW.getTime() + 40 * MIN)

    const out = ladderActions(advance([cleared], new Map(), later), [cleared], first, deps({ now: later }))
    const after = applyActions({ ...first, claims: [cleared] }, [...out.actions, ...out.brake], later)

    expect(first.ladder).toBeUndefined()
    expect(first.claims[0]?.stallCode).toBe('phase-timeout')
    expect(kinds(out.actions)).not.toContain('release')
    expect(after.claims[0]?.respawn).toMatchObject({ code: 'phase-timeout' })
  })
})
