import { describe, expect, it } from 'vitest'
import {
  coldStartCost,
  COST_WINDOW,
  CostTable,
  exitFootprints,
  MIN_MEASURED_EXITS,
  type ExitFootprint,
} from '../agents/agent-cost.js'
import { footprintMeta, type Footprint } from '../agents/agent-footprint.js'
import type { AgentEventRow } from '../broker/event-store.js'
import { renderAgentCosts } from '../cli/verbs/machine.js'

const footprint = (over: Partial<Footprint> = {}): Footprint => ({
  samples: 6,
  cpuSeconds: 60,
  rssPeakKb: 1000,
  childrenPeak: 2,
  ...over,
})

const exit = (profile: string, role: string, over: Partial<Footprint> = {}): ExitFootprint => ({
  profile,
  role,
  footprint: footprint(over),
})

const exitsWithRss = (profile: string, role: string, rss: number[]): ExitFootprint[] =>
  rss.map(rssPeakKb => exit(profile, role, { rssPeakKb }))

function row(over: Partial<AgentEventRow>): AgentEventRow {
  return {
    kind: 'agent_exited',
    ts: 0,
    actor: 'a',
    target: null,
    msgId: null,
    ref: null,
    body: null,
    meta: {},
    ...over,
  }
}

describe('a cost estimate', () => {
  it('takes the median and p90 of a profile and role over its exits', () => {
    const rss = Array.from({ length: 10 }, (_, i) => (i + 1) * 100)
    const table = new CostTable(exitsWithRss('p', 'reviewer', rss))

    const estimate = table.estimate('p', 'reviewer')

    expect(estimate.source).toBe('measured')
    expect(estimate.exits).toBe(10)
    expect(estimate.rssKb).toEqual({ median: 500, p90: 900 })
  })

  it('reads CPU as cores over the sampled run', () => {
    const table = new CostTable(exitsWithRss('p', 'r', [1, 1, 1]))

    expect(table.estimate('p', 'r').cpuCores).toEqual({ median: 1, p90: 1 })
  })

  it('keeps only the last exits of a key, so an old regime ages out', () => {
    const old = exitsWithRss('p', 'r', Array(COST_WINDOW).fill(9000))
    const recent = exitsWithRss('p', 'r', Array(COST_WINDOW).fill(100))

    const estimate = new CostTable([...old, ...recent]).estimate('p', 'r')

    expect(estimate.exits).toBe(COST_WINDOW)
    expect(estimate.rssKb.p90).toBe(100)
  })

  it('falls back to the profile across roles when the role is too new', () => {
    const table = new CostTable([...exitsWithRss('p', 'reviewer', [100, 100, 100]), exit('p', 'other')])

    const estimate = table.estimate('p', 'other')

    expect(estimate.source).toBe('profile')
    expect(estimate.exits).toBe(4)
  })

  it('uses the cold-start default below the minimum exits, per profile', () => {
    const table = new CostTable(
      exitsWithRss('bd-reviewer', 'reviewer', Array(MIN_MEASURED_EXITS - 1).fill(1)),
    )

    const reviewer = table.estimate('bd-reviewer', 'reviewer')
    const implementer = table.estimate('bd-implementer', 'implementer')
    const lite = table.estimate('bd-implementer-lite', 'implementer')

    expect(reviewer).toMatchObject({ source: 'default', exits: MIN_MEASURED_EXITS - 1 })
    expect(reviewer.rssKb).toEqual(coldStartCost('bd-reviewer').rssKb)
    expect(implementer.rssKb.p90).toBeGreaterThan(lite.rssKb.p90)
    expect(lite.rssKb.p90).toBeGreaterThan(reviewer.rssKb.p90)
  })

  it('reads a zero tmp cost when no run reported files', () => {
    const table = new CostTable(exitsWithRss('p', 'r', [1, 1, 1]))

    expect(table.estimate('p', 'r').tmpFiles).toEqual({ median: 0, p90: 0 })
  })

  it('lists each key once, costliest first', () => {
    const table = new CostTable([
      ...exitsWithRss('small', 'r', [1, 1, 1]),
      ...exitsWithRss('big', 'r', [9, 9, 9]),
    ])

    expect(table.rows().map(r => r.profile)).toEqual(['big', 'small'])
  })
})

describe('reading exits from the log', () => {
  const spawned = (agentId: string, meta: Record<string, string>): AgentEventRow =>
    row({ kind: 'agent_spawned', msgId: agentId, target: 'n', meta })
  const exited = (agentId: string, meta: Record<string, string>): AgentEventRow => row({ ref: agentId, meta })
  const measured = footprintMeta(footprint()) as Record<string, string>

  it('joins an exit to its spawn for profile and role', () => {
    const rows = [
      spawned('a1', { profile: 'bd-reviewer', work_role: 'shepherd-review' }),
      exited('a1', measured),
    ]

    expect(exitFootprints(rows)).toEqual([
      { profile: 'bd-reviewer', role: 'shepherd-review', footprint: footprint() },
    ])
  })

  it('infers the role when the spawn row has none', () => {
    const rows = [spawned('a1', { profile: 'bd-implementer' }), exited('a1', measured)]

    expect(exitFootprints(rows)[0]?.role).toBe('implementer')
  })

  it('counts each measured run of a resumed agent', () => {
    const rows = [spawned('a1', { profile: 'p' }), exited('a1', measured), exited('a1', measured)]

    expect(exitFootprints(rows)).toHaveLength(2)
  })

  it('skips failed starts, unmeasured exits and exits with no spawn', () => {
    const rows = [
      spawned('a1', { profile: 'p' }),
      exited('a1', { ...measured, failed: 'true' }),
      exited('a1', {}),
      exited('ghost', measured),
    ]

    expect(exitFootprints(rows)).toEqual([])
  })
})

describe('the machine costs view', () => {
  it('shows a measured agent, an unsampled one and each estimate as median/p90', () => {
    const estimate = new CostTable(exitsWithRss('bd-reviewer', 'reviewer', [1048576, 1048576, 2097152]))

    const lines = renderAgentCosts({
      running: [
        {
          name: 'r1',
          profile: 'bd-reviewer',
          role: 'reviewer',
          cpuSeconds: 12.4,
          rssPeakKb: 1048576,
          childrenPeak: 3,
        },
        { name: 'r2', profile: 'bd-reviewer', role: 'reviewer' },
      ],
      estimates: estimate.rows(),
    })

    expect(lines).toEqual([
      'running: 2',
      '  r1 (bd-reviewer, reviewer): cpu 12s, rss 1.0G, children 3',
      '  r2 (bd-reviewer, reviewer): no sample yet',
      'cost by profile and role, median/p90:',
      '  bd-reviewer, reviewer: rss 1.0G/2.0G, cores 1.0/1.0, children 2/2, tmp files 0/0 (3 exits, measured)',
    ])
  })

  it('says so when nothing has been measured', () => {
    expect(renderAgentCosts({ running: [], estimates: [] })).toContain('  no measured exits yet')
  })
})
