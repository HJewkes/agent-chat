import { planSeat } from '../agents/burndown/seat-plan.js'
import type { ScoringDefaults } from '../agents/burndown/score.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import { describe, expect, it } from 'vitest'
import type { Claim } from '../agents/burndown/ledger.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { healSlice, isInitiativeDir, sliceRepo, taskRepo } from '../agents/burndown/slice-repo.js'
import { readSlices } from '../agents/burndown/report.js'
import { sliceClaims } from '../agents/burndown/seed-slices.js'

/** CC-1228: a queued slice whose repo the seat does not list moves to the ticking seat that lists it, else parks once. */

const seatOf = (name: string, repos: Record<string, string[]>): SeatDispatch => ({
  seat: name,
  prefix: name.slice(0, 2),
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos,
  caps: { implementers: 2, reviewers: 1, planners: 1 },
  worktrees: { perRepoPerSeat: 3, capName: 'concurrency.implementers', leftFreePerRepo: 2 },
  excludedTags: [],
  grants: [],
})

const HOME = seatOf('seat-a', { alpha: ['/tmp/repos/alpha-app'] })
const OTHER = seatOf('seat-b', { alpha: ['/tmp/repos/beta-lib'] })

const slice = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'A-1',
  slice: 'a',
  initiative: 'alpha',
  seat: 'seat-a',
  namePrefix: 'sa',
  spawnedAt: '2026-10-13T09:00:00.000Z',
  phase: 'queued',
  phaseAt: '2026-10-13T09:00:00.000Z',
  ...patch,
})

describe('healSlice', () => {
  it('moves a slice to the ticking seat that lists its repo', () => {
    const heal = healSlice(HOME, [OTHER], 'alpha', [], slice({ repo: 'beta-lib' }))
    expect(heal).toEqual({ kind: 'rehome', to: 'seat-b' })
  })

  it('parks a slice no ticking seat lists, naming the repo', () => {
    const heal = healSlice(HOME, [OTHER], 'alpha', [], slice({ repo: 'gamma-svc' }))
    expect(heal).toEqual({
      kind: 'park',
      reason: 'seat seat-a lists no repo gamma-svc for alpha, and no ticking seat does',
    })
  })

  it('does nothing when the seat lists the repo itself', () => {
    expect(healSlice(HOME, [OTHER], 'alpha', [], slice({ repo: 'alpha-app' }))).toBeUndefined()
  })

  it('leaves a slice with an agent or a PR where it is', () => {
    expect(
      healSlice(HOME, [OTHER], 'alpha', [], slice({ repo: 'beta-lib', agentName: 'sa-a' })),
    ).toBeUndefined()
    expect(
      healSlice(HOME, [OTHER], 'alpha', [], slice({ repo: 'beta-lib', pr: 'HJewkes/x#7' })),
    ).toBeUndefined()
  })

  it('parks a plan and tag that disagree when no peer settles it', () => {
    const heal = healSlice(HOME, [], 'alpha', ['repo:other'], slice({ repo: 'alpha-app' }))
    expect(heal).toMatchObject({ kind: 'park' })
  })

  it('does not repeat the park for a slice already parked no-repo', () => {
    const parked = slice({ repo: 'gamma-svc', stallCode: 'no-repo', stalledReason: 'no-repo: x' })
    expect(healSlice(HOME, [OTHER], 'alpha', [], parked)).toEqual({ kind: 'parked' })
  })

  it('unparks a slice once the seat lists its repo', () => {
    const parked = slice({ repo: 'alpha-app', stallCode: 'no-repo', stalledReason: 'no-repo: x' })
    expect(healSlice(HOME, [OTHER], 'alpha', [], parked)).toEqual({ kind: 'unpark' })
  })

  it('rehomes a parked slice when a peer now lists its repo', () => {
    const parked = slice({ repo: 'beta-lib', stallCode: 'no-repo', stalledReason: 'no-repo: x' })
    expect(healSlice(HOME, [OTHER], 'alpha', [], parked)).toEqual({ kind: 'rehome', to: 'seat-b' })
  })
})

describe('initiative directories are never a repo', () => {
  const sources = '/tmp/share/active-work/alpha/sources/autonomy/bin'

  it('recognises a path under an initiative sources or tasks directory', () => {
    expect(isInitiativeDir(sources)).toBe(true)
    expect(isInitiativeDir('/tmp/share/active-work/alpha/tasks')).toBe(true)
    expect(isInitiativeDir('/tmp/repos/active-work')).toBe(false)
    expect(isInitiativeDir('/tmp/repos/alpha-app')).toBe(false)
  })

  it('resolves a task to no repo when the only listed checkout is one', () => {
    const seat = seatOf('seat-a', { alpha: [sources] })
    expect(taskRepo(seat, 'alpha', [])).toBeUndefined()
  })

  it('parks the slice instead of reading PRs there', () => {
    const seat = seatOf('seat-a', { alpha: [sources] })
    expect(healSlice(seat, [], 'alpha', [], slice())).toMatchObject({ kind: 'park' })
  })
})

describe('planSeat with peers', () => {
  const NOW = new Date('2026-10-13T12:00:00.000Z')
  const plan = (claims: Claim[], peers: SeatDispatch[] | undefined) =>
    planSeat({
      seat: HOME,
      rows: [],
      defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
      tasks: new Map([
        [
          'alpha',
          [
            {
              id: 'A-1',
              title: 't',
              status: 'open',
              priority: 1,
              estimate: 2,
              doneWhen: 'It works.',
              tags: [],
            },
          ],
        ],
      ]),
      ledger: { ...EMPTY_LEDGER, claims },
      budget: {
        pool: HOME.pool,
        spend: {},
        reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 },
        history: [],
        runStartAt: NOW.getTime() - 3_600_000,
        ctx: { now: NOW },
      },
      ...(peers === undefined ? {} : { peers }),
    })

  it('rewrites the claim seat and refuses nothing', () => {
    const planned = plan([slice({ repo: 'beta-lib' })], [OTHER])
    expect(planned.heals).toEqual([
      {
        kind: 'update',
        key: { taskId: 'A-1', slice: 'a' },
        patch: expect.objectContaining({ seat: 'seat-b' }),
      },
    ])
    expect(planned.refusals).toEqual([])
  })

  it('parks with stallCode no-repo once, then stays quiet', () => {
    const first = plan([slice({ repo: 'gamma-svc' })], [OTHER])
    expect(first.heals).toHaveLength(1)
    expect(first.heals[0]).toMatchObject({ patch: { stallCode: 'no-repo' } })
    const again = plan(
      [slice({ repo: 'gamma-svc', stallCode: 'no-repo', stalledReason: 'no-repo: x' })],
      [OTHER],
    )
    expect(again.heals).toEqual([])
    expect(again.refusals).toEqual([])
  })

  it('keeps today’s refusal without peers', () => {
    const planned = plan([slice({ repo: 'gamma-svc' })], undefined)
    expect(planned.refusals).toEqual([expect.objectContaining({ kind: 'no-repo' })])
  })
})

describe('a plan Repo: header routes a new-file-only slice (CC-1293)', () => {
  const NOW = new Date('2026-10-14T12:00:00.000Z')
  const SEAT = seatOf('seat-t', {
    'titan-platform': ['/tmp/repos/titan-platform'],
    'claude-channels': ['/tmp/repos/agent-chat'],
  })
  const PARENT = { taskId: 'TP-2853', initiative: 'titan-platform', seat: 'seat-t', namePrefix: 'tp' }
  const SLICES = [
    {
      n: 'a',
      title: 'shell startup',
      points: 1,
      doneWhen: 'a test passes',
      dependsOn: [],
      owns: ['src/leak-guard/shell-startup.ts'],
    },
  ]
  const fence = `\`\`\`burndown-slices\n${JSON.stringify(SLICES)}\n\`\`\``
  const routed = (plan: string) =>
    sliceRepo(SEAT, 'titan-platform', [], sliceClaims(PARENT, readSlices(plan).slices!, NOW)[0]!, () => false)

  it('dispatches into the checkout the header names', () => {
    expect(routed(`Repo: \`~/projects/agent-chat\`\n\n${fence}`)).toEqual({ repo: '/tmp/repos/agent-chat' })
  })

  it('falls back to the task repo without a header', () => {
    expect(routed(fence)).toEqual({ repo: '/tmp/repos/titan-platform' })
  })
})
