import { describe, expect, it } from 'vitest'
import type { ShepherdFlight } from '../agents/seats/in-flight-read.js'
import {
  deriveOperatorBrief,
  renderOperatorBrief,
  type BriefSeat,
  type OperatorBriefInput,
} from '../agents/seats/operator-brief.js'
import { readWaiting } from '../agents/seats/shepherd-waiting.js'
import type { AgentIdentity, QueueItem } from '../protocol.js'

/** CC-1551: the pure operator brief. Every seat, repo, sha and agent is synthetic. */

const NOW = new Date('2026-10-10T12:00:00.000Z')
const OPERATOR = 'tp-operator'

const seat = (name: string, prefix: string | undefined, caps = true): BriefSeat => ({
  name,
  prefix,
  caps: caps ? { implementer: 3, reviewer: 2 } : null,
})

const FIVE = ['aa', 'bb', 'cc', 'dd', 'ee'].map(p => seat(`${p}-coord`, p))

const flight = (over: Partial<ShepherdFlight>): ShepherdFlight => ({
  repo: 'acme/widgets',
  pr: 1,
  branch: null,
  runId: 'r',
  task: null,
  phase: 'awaiting-approval',
  headSha: 'a'.repeat(40),
  nextAction: null,
  pendingGate: null,
  gateSince: null,
  implementer: null,
  held: false,
  stalled: false,
  ...over,
})

const agent = (over: Partial<AgentIdentity>): AgentIdentity =>
  ({
    agentId: 'id',
    name: 'aa-impl',
    profile: 'implementer',
    state: 'running',
    spawnedBy: 'x',
    ...over,
  }) as AgentIdentity

const input = (over: Partial<OperatorBriefInput>): OperatorBriefInput => ({
  now: NOW,
  seats: FIVE,
  roster: [],
  inbox: {},
  shepherd: [],
  waiting: { owner: [], seat: [] },
  queue: [],
  pools: [],
  machineStop: null,
  paceAgeSeconds: 60,
  burndown: { pausedSince: null, lastTick: null },
  unavailable: [],
  ...over,
})

/** 41 runs across five seats; only the first two need someone to act. */
const fortyOne = Array.from({ length: 41 }, (_, i) => {
  const prefix = FIVE[i % 5]?.prefix as string
  const loud =
    i === 0
      ? { pendingGate: 'sh-sent-back', gateSince: '2026-10-10T10:00:00.000Z' }
      : i === 1
        ? { phase: 'fixing' }
        : { phase: i % 2 === 0 ? 'awaiting-approval' : 'review' }
  return flight({ pr: 100 + i, implementer: `${prefix}-impl-${i}`, ...loud })
})

describe('the operator brief text', () => {
  it('renders forty quiet PRs and five seats within the line budget', () => {
    const lines = renderOperatorBrief(deriveOperatorBrief(input({ shepherd: fortyOne })))

    const quiet = lines
      .filter(l => l.startsWith('  quiet: '))
      .flatMap(l => [...l.matchAll(/(\d+) [a-z-]+/g)].map(m => Number(m[1])))
    expect(lines.length).toBeLessThanOrEqual(60)
    expect(lines).toContain(`  pr acme/widgets#100 ${'a'.repeat(8)} awaiting-approval gate sh-sent-back 2h`)
    expect(lines).toContain(`  pr acme/widgets#101 ${'a'.repeat(8)} fixing`)
    expect(quiet.reduce((a, b) => a + b, 0)).toBe(39)
  })

  it('files a run whose implementer and branch match no seat under the operator as inherited', () => {
    const orphan = flight({
      pr: 9,
      implementer: 'zz-gone-fix',
      branch: 'agent-chat/zz-gone',
      phase: 'fixing',
    })
    const brief = deriveOperatorBrief(
      input({ seats: [...FIVE, seat(OPERATOR, 'tpo', false)], shepherd: [orphan] }),
    )

    const operator = brief.seats.find(s => s.seat === OPERATOR)
    expect(operator?.prs).toMatchObject([{ pr: 'acme/widgets#9', inherited: true }])
    expect(renderOperatorBrief(brief)).toContain(`  pr acme/widgets#9 ${'a'.repeat(8)} fixing (inherited)`)
  })

  it('counts agents that exited after the seat last sent as finished and earlier exits not', () => {
    const cutoff = Date.parse('2026-10-10T11:00:00.000Z')
    const exited = (name: string, at: number): AgentIdentity =>
      agent({ name, state: 'exited', exitedAt: at, spawnedBy: 'aa-coord' })
    const brief = deriveOperatorBrief(
      input({
        roster: [exited('aa-before', cutoff - 1), exited('aa-at', cutoff), exited('aa-after', cutoff + 1)],
        inbox: { 'aa-coord': { unread: 2, sinceLastSend: new Date(cutoff).toISOString() } },
      }),
    )

    expect(brief.seats[0]).toMatchObject({ seat: 'aa-coord', finished: ['aa-after'], unread: 2 })
  })

  it('prints each unavailable source even when the seat lines overflow', () => {
    const unavailable = [
      { source: 'shepherd', reason: 'serve down' },
      { source: 'queue', reason: 'no broker' },
    ]
    const roster = FIVE.flatMap(s =>
      [1, 2, 3].map(i => agent({ name: `${s.prefix}-a${i}`, spawnedBy: s.name })),
    )

    const lines = renderOperatorBrief(
      deriveOperatorBrief(input({ shepherd: fortyOne, roster, unavailable })),
      { maxLines: 6 },
    )

    expect(lines).toContain('unavailable: shepherd (serve down)')
    expect(lines).toContain('unavailable: queue (no broker)')
    expect(lines.some(l => l.startsWith('  '))).toBe(false)
  })

  it('cuts quiet counts before an actionable PR when the height is capped', () => {
    const lines = renderOperatorBrief(deriveOperatorBrief(input({ shepherd: fortyOne })), { maxLines: 12 })

    expect(lines.some(l => l.startsWith('  quiet: '))).toBe(false)
    expect(lines.some(l => l.startsWith('  pr acme/widgets#100 '))).toBe(true)
  })

  it('shows caps as n/a for a seat the charter does not list', () => {
    const lines = renderOperatorBrief(deriveOperatorBrief(input({ seats: [seat(OPERATOR, 'tpo', false)] })))

    expect(lines).toContain('== tp-operator  impl 0/n/a rev 0/n/a · unread ? · finished 0')
  })

  it('counts only open questions in the owner queue, not its notices', () => {
    const item = (kind: QueueItem['kind'], msgId: string): QueueItem => ({
      msgId,
      kind,
      from: 'aa-coord',
      text: 't',
      at: 0,
      meta: {},
    })
    const queue = [item('question', 'q1'), item('notice', 'n1'), item('endorse_request', 'e1')]

    const lines = renderOperatorBrief(deriveOperatorBrief(input({ queue })))

    expect(lines).toContain('owner: 1 questions · 0 gates')
  })
})

describe('the Shepherd waiting reader', () => {
  const body = JSON.stringify({
    owner: [
      {
        gateId: 'r1/approve-merge:1',
        stepId: 'approve-merge',
        repo: 'acme/widgets',
        pr: 3,
        head: 'b'.repeat(40),
        task: 'init/T-3',
        since: '2026-10-08T12:00:00.000Z',
        ageHours: 48,
        headIsCurrent: true,
        held: null,
        later: 'an unknown key',
      },
    ],
    seat: [
      { gateId: 'r2/ci-failed:1', stepId: 'ci-failed', repo: 'acme/widgets', pr: 4, since: 'x', ageHours: 1 },
    ],
  })

  it('reads owner and seat gates when the command exited 1 with valid JSON', () => {
    const waiting = readWaiting({ status: 1, stdout: body })

    expect(waiting.owner).toMatchObject([{ stepId: 'approve-merge', pr: 3, held: false }])
    expect(waiting.seat).toMatchObject([{ stepId: 'ci-failed', head: null, task: null }])
  })

  it('throws on another exit code so the brief reports Shepherd unavailable', () => {
    expect(() => readWaiting({ status: 2, stdout: body })).toThrow()
  })
})
