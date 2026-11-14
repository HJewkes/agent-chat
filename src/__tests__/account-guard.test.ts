import { describe, expect, it } from 'vitest'
import type { AccountUsage } from '../agents/account-budget.js'
import {
  emptyGuardState,
  GUARD_DWELL_MS,
  guardDecision,
  nextGuardState,
  type GuardInput,
  type GuardSeat,
  type GuardState,
} from '../agents/account-guard.js'
import { runGuard, type GuardDeps } from '../agents/account-guard-pass.js'
import { DEFAULT_ROTATION } from '../agents/account-rotation.js'
import type { ClientMessage, SessionInfo } from '../protocol.js'
import type { BrokerClient } from '../client/broker-client.js'
import { liveGuardDeps } from '../cli/verbs/accounts-guard.js'

/** CC-894: the account guard over fake readings and a fake clock; nothing reads a real login. */

const NOW = Date.parse('2026-11-14T12:00:00Z')
const MIN = 60_000
const root = '/synthetic/.claude-profiles'
const dirOf = (account: string): string => `${root}/${account}`

interface Fake {
  fiveHour?: number
  /** Epoch ms the tripping window resets at. */
  resetsAt?: number
  stale?: boolean
}

const usage = (account: string, sevenDay: number, fake: Fake = {}): AccountUsage => {
  const resets = fake.resetsAt === undefined ? {} : { resets_at: fake.resetsAt / 1000 }
  return {
    account,
    config_dir: dirOf(account),
    source: 'usage-poller',
    five_hour: { used_pct: fake.fiveHour ?? 0, ...resets },
    seven_day: { used_pct: sevenDay, ...resets },
    age_seconds: 60,
    stale: fake.stale ?? false,
    auth_fail: false,
  }
}

const seat = (over: Partial<GuardSeat> = {}): GuardSeat => ({
  name: 'coord-a',
  configDir: dirOf('alpha'),
  declares: true,
  live: true,
  idleMs: 30 * MIN,
  ...over,
})

const decide = (usages: AccountUsage[], over: Partial<GuardInput> = {}) =>
  guardDecision({
    seat: seat(),
    usages,
    config: DEFAULT_ROTATION,
    state: emptyGuardState(),
    now: NOW,
    ...over,
  })

const movedAt = (at: number, blocked: Record<string, number> = {}): GuardState => ({
  seats: { 'coord-a': { lastMoveAt: at, blocked } },
})

describe('the account guard deciding one seat', () => {
  // Mutation: dropping the five_hour trip leaves this seat where it is.
  it('moves a seat at the five_hour ceiling to the least-used account', () => {
    const decision = decide([usage('alpha', 50, { fiveHour: 92 }), usage('beta', 20), usage('gamma', 30)])

    expect(decision).toMatchObject({ kind: 'move', from: dirOf('alpha'), to: dirOf('beta') })
  })

  // Mutation: `>=` to `>` on SEVEN_DAY_TRIP_PCT leaves a seat at exactly 90% unmoved.
  it('moves a seat at 90% seven_day though its five_hour is quiet', () => {
    const decision = decide([usage('alpha', 90, { fiveHour: 10 }), usage('beta', 40)])

    expect(decision).toMatchObject({ kind: 'move', to: dirOf('beta') })
  })

  // Mutation: moving on any reading, not only a tripped one, moves this seat.
  it('leaves a seat under both thresholds where it is', () => {
    const decision = decide([usage('alpha', 89, { fiveHour: 89 }), usage('beta', 5)])

    expect(decision).toMatchObject({ kind: 'none', reason: 'under threshold' })
  })

  // Mutation: taking the least-used pick without the headroom margin moves to beta.
  it('does not move to a target with under 15 points more seven_day headroom', () => {
    const decision = decide([usage('alpha', 92), usage('beta', 78)])

    expect(decision.kind).toBe('notice')
  })

  // Mutation: not recording `noticed` raises the notice again on the second tick.
  it('raises one owner notice per episode when no target qualifies', () => {
    const usages = [usage('alpha', 95, { resetsAt: NOW + 600 * MIN }), usage('beta', 91)]
    const first = decide(usages)
    const state = nextGuardState(emptyGuardState(), first, NOW)

    const second = decide(usages, { state, now: NOW + 15 * MIN })

    expect(first.kind).toBe('notice')
    expect(second).toMatchObject({ kind: 'none', reason: 'no target; owner already told' })
  })

  // Mutation: dropping the dwell, or `<` to `<=`, moves or holds at the wrong edge.
  it('holds a seat moved 30 minutes ago for the 60-minute dwell', () => {
    const usages = [usage('alpha', 50, { fiveHour: 95 }), usage('beta', 10)]

    expect(decide(usages, { state: movedAt(NOW - 30 * MIN) }).kind).toBe('hold')
    expect(decide(usages, { state: movedAt(NOW - GUARD_DWELL_MS) }).kind).toBe('move')
  })

  // Mutation: ignoring `blocked` sends the seat back to alpha before its reset.
  it('never moves back to the account it left before the reset that tripped the move', () => {
    const resetAt = NOW + 120 * MIN
    const state = movedAt(NOW - 2 * GUARD_DWELL_MS, { [dirOf('alpha')]: resetAt })
    const onBeta = { seat: seat({ configDir: dirOf('beta') }), state }
    const usages = [usage('alpha', 5), usage('beta', 50, { fiveHour: 95 }), usage('gamma', 30)]

    expect(decide(usages, onBeta)).toMatchObject({ kind: 'move', to: dirOf('gamma') })
    expect(decide(usages, { ...onBeta, now: resetAt })).toMatchObject({ kind: 'move', to: dirOf('alpha') })
  })

  // Mutation: clearing `blocked` on the next move forgets alpha's reset.
  it('keeps the account it left off limits after a later move', () => {
    const tripped = { fiveHour: 95, resetsAt: NOW + 300 * MIN }
    const first = decide([usage('alpha', 50, tripped), usage('beta', 10), usage('gamma', 30)])
    const later = NOW + 2 * GUARD_DWELL_MS
    const state = nextGuardState(emptyGuardState(), first, NOW)
    const second = decide([usage('alpha', 5), usage('beta', 50, { fiveHour: 95 }), usage('gamma', 30)], {
      seat: seat({ configDir: dirOf('beta') }),
      state,
      now: later,
    })
    const afterSecond = nextGuardState(state, second, later)

    expect(second).toMatchObject({ kind: 'move', to: dirOf('gamma') })
    expect(afterSecond.seats['coord-a']?.blocked[dirOf('alpha')]).toBe(NOW + 300 * MIN)
  })

  // Mutation: dropping the declares check moves a seat nobody opted in.
  it('leaves a seat that does not declare account: least-used untouched', () => {
    const decision = decide([usage('alpha', 95), usage('beta', 5)], { seat: seat({ declares: false }) })

    expect(decision.kind).toBe('none')
  })

  // Mutation: dropping the idle check ends a seat mid-turn.
  it('leaves a busy seat untouched', () => {
    const decision = decide([usage('alpha', 95), usage('beta', 5)], { seat: seat({ idleMs: 10_000 }) })

    expect(decision).toMatchObject({ kind: 'none', reason: 'busy (active 10s ago)' })
  })

  // Mutation: trusting a stale reading moves on a number that says nothing about now.
  it('does not act on a stale reading of the seat’s own account', () => {
    const decision = decide([usage('alpha', 95, { stale: true }), usage('beta', 5)])

    expect(decision.kind).toBe('none')
  })
})

const LEAST_USED_SEAT = '---\nprefix: CA\npool: alpha\naccount: least-used\n---\n'

const rosterRow = (name: string, configDir: string, idleMs: number): SessionInfo =>
  ({
    name,
    workingOn: 'a synthetic task',
    cwd: '/tmp/demo',
    status: 'available',
    dnd: false,
    idleMs,
    registeredAt: 0,
    observed: { configDir },
  }) as SessionInfo

function fakeDeps(idleMs: number) {
  const moves: { name: string; to: string }[] = []
  const saved: GuardState[] = []
  const logged: { seat: string; text: string }[] = []
  const deps: GuardDeps = {
    seats: () => [
      { name: 'coord-a', seatFile: LEAST_USED_SEAT },
      { name: 'coord-b', seatFile: '---\nprefix: CB\npool: alpha\n---\n' },
    ],
    roster: async () => [
      rosterRow('coord-a', dirOf('alpha'), idleMs),
      rosterRow('coord-b', dirOf('alpha'), idleMs),
    ],
    readings: () => [usage('alpha', 50, { fiveHour: 95 }), usage('beta', 10)],
    config: () => DEFAULT_ROTATION,
    readState: emptyGuardState,
    saveState: state => saved.push(state),
    move: async (name, to) => {
      moves.push({ name, to })
      return { ok: true, detail: `moving to ${to}` }
    },
    notify: async () => ({ ok: true, detail: 'notice' }),
    seatLog: (seat, text) => logged.push({ seat, text }),
    now: () => NOW,
  }
  return { deps, moves, saved, logged }
}

describe('one guard tick', () => {
  // Mutation: not saving the state after a move loses the dwell.
  it('moves only the declaring idle seat and records the move', async () => {
    const { deps, moves, saved } = fakeDeps(30 * MIN)

    await runGuard(deps, { dryRun: false })

    expect(moves).toEqual([{ name: 'coord-a', to: dirOf('beta') }])
    expect(saved.at(-1)?.seats['coord-a']?.lastMoveAt).toBe(NOW)
  })

  // Mutation: sending before the dry-run check moves the seat.
  it('sends no move and writes no state on a dry run', async () => {
    const { deps, moves, saved } = fakeDeps(30 * MIN)

    const lines = await runGuard(deps, { dryRun: true })

    expect(moves).toEqual([])
    expect(saved).toEqual([])
    expect(lines.join('\n')).toContain('coord-a: WOULD MOVE alpha -> beta')
  })

  // Mutation: reading idleMs as 0-means-idle moves a busy seat.
  it('sends no move for a seat active 10 seconds ago', async () => {
    const { deps, moves } = fakeDeps(10_000)

    await runGuard(deps, { dryRun: false })

    expect(moves).toEqual([])
  })
})

describe('the guard’s own record of a move', () => {
  // Mutation: skipping the seat log leaves the seat's journal with no record of who moved it.
  it('logs the move in the seat’s journal as by account-guard', async () => {
    const { deps, logged } = fakeDeps(30 * MIN)

    await runGuard(deps, { dryRun: false })

    expect(logged).toEqual([
      { seat: 'coord-a', text: expect.stringMatching(/^account-guard moved this seat alpha -> beta: /) },
    ])
  })

  // Mutation: dropping `source` from the frame records the guard's move as the human's.
  it('marks its account_move frame with source guard', async () => {
    const sent: ClientMessage[] = []
    const client = {
      request: async (msg: ClientMessage) => {
        sent.push(msg)
        return { t: 'teleport_result', ok: true }
      },
    } as unknown as BrokerClient
    const pool = { readings: () => [], config: () => DEFAULT_ROTATION }

    await liveGuardDeps('/synthetic/autonomy', client, pool).move('coord-a', 'beta')

    expect(sent).toEqual([{ t: 'account_move', name: 'coord-a', to: 'beta', source: 'guard' }])
  })
})
