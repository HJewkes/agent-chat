import { describe, expect, it } from 'vitest'
import {
  ageDays,
  combine,
  compareRows,
  dependencyGraph,
  dispatchOrder,
  kindOf,
  kindWeight,
  namedDependencies,
  priorityPercentile,
  pyRound,
  readinessTerm,
  route,
  scoreAll,
  severityTerm,
  sizeTerm,
  stalenessTerm,
  stopShortNames,
  stopShortTerm,
  unblocksTerm,
  type Components,
  type ScoredTask,
  type ScoreRow,
  type ScoringDefaults,
} from '../agents/burndown/score.js'

/**
 * Each table pins one term against score.py's formula (CC-201 plan section
 * 1.1). The scoreAll expectations were produced by running score.py's
 * score_all over the same tasks with today pinned to 2026-09-29.
 */

const DEFAULTS: ScoringDefaults = {
  kind_weights: {
    security: 1.0,
    product: 1.0,
    correctness: 0.9,
    platform: 0.8,
    'agent-tooling': 0.6,
    docs: 0.5,
    nit: 0.35,
  },
  share_caps: {},
  initiative_decay: 0.85,
  score_terms: { severity: 0.4, priority_pct: 0.3, unblocks: 0.2, staleness: 0.1 },
  severity: { critical: 1.0, high: 0.7, medium: 0.4, low: 0.15, unset: 0.3 },
  readiness: { ready: 1.0, untriaged: 0.6, blocked: 0.25 },
  size: { le3: 1.0, le8: 0.9, gt8: 0.75 },
  stop_short_factor: 0.8,
}
const TODAY = '2026-09-29'

function task(fields: Partial<ScoredTask> = {}): ScoredTask {
  return { id: 'X-1', title: 'Something', priority: 10, slug: 'a', ...fields }
}

describe('pyRound matches Python round()', () => {
  it.each([
    [57.25, 1, 57.2],
    [0.35, 1, 0.3],
    [2.675, 2, 2.67],
    [0.125, 2, 0.12],
    [0.5, 0, 0],
    [1.5, 0, 2],
    [2.5, 0, 2],
    [-57.25, 1, -57.2],
    [57.35, 1, 57.4],
    [62.05, 1, 62.0],
    [0, 1, 0],
  ])('round(%s, %s) is %s', (x, digits, expected) => {
    expect(pyRound(x, digits)).toBe(expected)
  })
})

describe('severity S', () => {
  it.each([
    ['critical', 1.0],
    ['low', 0.15],
    [undefined, 0.3],
    [null, 0.3],
    ['', 0.3],
    ['catastrophic', 0.3],
    ['constructor', 0.3],
  ])('severity %s scores %s', (severity, expected) => {
    expect(severityTerm(severity, DEFAULTS)).toBe(expected)
  })
})

describe('priority percentile P', () => {
  it.each([
    ['the most urgent of three', 10, [10, 20, 30], 1],
    ['the middle of three', 20, [10, 20, 30], 0.5],
    ['the least urgent of three', 30, [10, 20, 30], 0],
    ['a lone task', 10, [10], 1],
    ['a tie after one ahead', 20, [10, 20, 20], 0.5],
    ['peers that include an excluded task', 20, [10, 20, 30, 40], 1 - 1 / 3],
  ])('%s gets %s', (_scenario, priority, peers, expected) => {
    expect(priorityPercentile(priority, peers)).toBeCloseTo(expected as number, 12)
  })
})

describe('named dependencies', () => {
  it.each([
    ['depends on in done_when', { done_when: 'Depends on A-1 and B-2.' }, ['A-1', 'B-2']],
    ['blocked by in notes', { notes: 'Blocked by C-3.' }, ['C-3']],
    ['waits for in the title', { title: 'Waits for TP-40' }, ['TP-40']],
    ['requires an ID', { done_when: 'requires R-9 first' }, ['R-9']],
    ['after an ID', { done_when: 'lands after R-9' }, ['R-9']],
    ['an ID in a non-dependency sentence', { done_when: 'Mirrors A-1. Depends on B-2.' }, ['B-2']],
    ['sentences split on a semicolon', { done_when: 'see A-1; prereq B-2' }, ['B-2']],
    ['its own ID', { id: 'A-1', done_when: 'Depends on A-1 and A-2.' }, ['A-2']],
    ['a lowercase ID', { done_when: 'Depends on a-1.' }, []],
    ['an ID longer than five letters', { done_when: 'Depends on ABCDEF-1.' }, []],
    ['a null field', { done_when: null, notes: 'Depends on A-7.' }, ['A-7']],
  ])('reads %s', (_scenario, fields, expected) => {
    expect([...namedDependencies(task(fields))].sort()).toEqual(expected)
  })
})

describe('unblocks U and blocked', () => {
  const tasks = [
    task({ id: 'A-1' }),
    task({ id: 'A-2', done_when: 'Depends on A-1 and Z-9.' }),
    task({ id: 'A-3', notes: 'Blocked by A-1.' }),
    task({ id: 'A-4', tags: ['human-only'], notes: 'Blocked by A-1.' }),
    task({ id: 'A-5', notes: 'Depends on A-1. Depends on A-1 again.' }),
  ]
  const graph = dependencyGraph(tasks)

  it.each([
    ['A-1', 4, []],
    ['A-2', 0, ['A-1']],
    ['A-5', 0, ['A-1']],
  ])('%s unblocks %s and waits on %j', (id, unblocks, blocked) => {
    expect(graph.unblocks.get(id) ?? 0).toBe(unblocks)
    expect(graph.blocked.get(id)).toEqual(blocked)
  })

  it.each([
    [0, 0],
    [1, 1 / 3],
    [3, 1],
    [5, 1],
  ])('%s naming tasks give U = %s', (count, expected) => {
    expect(unblocksTerm(count)).toBe(expected)
  })
})

describe('staleness A', () => {
  it.each([
    ['updated wins over created', { updated: '2026-09-19', created: '2026-01-01' }, 10],
    ['created when never updated', { created: '2026-09-14' }, 15],
    ['a timestamp read by its first 10 characters', { updated: '2026-09-28T23:59:00Z' }, 1],
    ['an unparseable date', { created: 'soon' }, 0],
    ['an impossible date', { created: '2026-02-30' }, 0],
    ['no date at all', {}, 0],
    ['a future date', { created: '2026-10-01' }, -2],
  ])('%s gives %s days', (_scenario, fields, expected) => {
    expect(ageDays(task(fields), TODAY)).toBe(expected)
  })

  it.each([
    ['2026-02-30', 'today is an invalid date, got 2026-02-30'],
    ['2026-13-45', 'today is an invalid date, got 2026-13-45'],
    ['29/09/2026', 'today must be YYYY-MM-DD, got 29/09/2026'],
    ['20260929', 'today must be YYYY-MM-DD, got 20260929'],
  ])('refuses --today %s with a distinct message', (today, message) => {
    expect(() => ageDays(task({ created: '2026-09-14' }), today)).toThrow(message)
  })

  it.each([
    [0, 0],
    [15, 0.5],
    [30, 1],
    [59, 1],
    [-3, -0.1],
  ])('%s days give A = %s', (days, expected) => {
    expect(stalenessTerm(days)).toBe(expected)
  })
})

describe('kind K', () => {
  it.each([
    ['the first kind: tag', { tags: ['x', 'kind:docs', 'kind:nit'] }, 'docs', 'tag'],
    ['a kind: tag over a title regex', { title: 'Leak fix', tags: ['kind:product'] }, 'product', 'tag'],
    ['security before nit', { title: 'Cleanup of the secret store' }, 'security', 'regex'],
    ['a regex hit in the tags', { tags: ['Security'] }, 'security', 'regex'],
    ['a word boundary', { title: 'Import the report' }, 'platform', 'default'],
    ['platform by regex', { title: 'Port the adapter' }, 'platform', 'regex'],
    ['agent-tooling last', { title: 'Worktree budget' }, 'agent-tooling', 'regex'],
    ['nothing matching', { title: 'Something' }, 'platform', 'default'],
  ])('%s', (_scenario, fields, kind, source) => {
    expect(kindOf(task(fields))).toEqual({ kind, source })
  })

  it.each([
    ['security', 1.0],
    ['nit', 0.35],
    ['unlisted', 0.8],
    ['constructor', 0.8],
  ])('kind %s weighs %s', (kind, expected) => {
    expect(kindWeight(kind, DEFAULTS)).toBe(expected)
  })
})

describe('readiness R', () => {
  it.each([
    ['ready', { estimate: 2, done_when: 'x' }, false, 1.0],
    ['blocked beats untriaged', {}, true, 0.25],
    ['no estimate', { done_when: 'x' }, false, 0.6],
    ['no done_when', { estimate: 2 }, false, 0.6],
    ['an empty done_when', { estimate: 2, done_when: '' }, false, 0.6],
    ['a zero estimate is still an estimate', { estimate: 0, done_when: 'x' }, false, 1.0],
  ])('%s', (_scenario, fields, blocked, expected) => {
    expect(readinessTerm(task(fields), blocked, DEFAULTS)).toBe(expected)
  })
})

describe('size Z', () => {
  it.each([
    [undefined, 1.0],
    [null, 1.0],
    [3, 1.0],
    [4, 0.9],
    [8, 0.9],
    [13, 0.75],
  ])('estimate %s sizes %s', (estimate, expected) => {
    expect(sizeTerm(estimate, DEFAULTS)).toBe(expected)
  })
})

describe('stop-short H', () => {
  const charterStops = new Set(['deploy', 'config-edit', 'broker-restart', 'dotfiles-merge'])

  it.each([
    ['a deploy', 'Deploy the worker.', ['deploy']],
    ['two stops in pattern order', 'Edit CLAUDE.md, then deploy.', ['deploy', 'config-edit']],
    ['a restart window', 'ships in a restart window', ['broker-restart']],
    ['a stop the charter does not list', 'npm publish the package', []],
    ['a stop with no pattern', 'merge the dotfiles', []],
    ['a word-boundary miss', 'redeployment notes', []],
    ['no done_when', null, []],
  ])('%s', (_scenario, doneWhen, expected) => {
    expect(stopShortNames(doneWhen, charterStops)).toEqual(expected)
  })

  it.each([
    [[], 1],
    [['deploy'], 0.8],
    [['deploy', 'config-edit'], 0.8],
  ])('stops %j give H = %s', (stops, expected) => {
    expect(stopShortTerm(stops, DEFAULTS)).toBe(expected)
  })
})

describe('route', () => {
  it.each([
    ['no estimate', { done_when: 'x' }, 'triage'],
    ['no done_when', { estimate: 5 }, 'triage'],
    ['estimate 3', { estimate: 3, done_when: 'x' }, 'planner'],
    ['estimate 2', { estimate: 2, done_when: 'x' }, 'implementer'],
    ['estimate 1', { estimate: 1, done_when: 'x' }, 'implementer-lite'],
    ['estimate 0', { estimate: 0, done_when: 'x' }, 'implementer-lite'],
  ])('%s routes to %s', (_scenario, fields, expected) => {
    expect(route(task(fields))).toBe(expected)
  })
})

describe('combined score', () => {
  const unit: Components = { S: 1, P: 1, U: 1, A: 1, W: 1, K: 1, R: 1, Z: 1, H: 1 }

  it.each([
    ['every term at 1', unit, 100],
    ['severity alone', { ...unit, P: 0, U: 0, A: 0 }, 40],
    ['priority alone', { ...unit, S: 0, U: 0, A: 0 }, 30],
    ['unblocks alone', { ...unit, S: 0, P: 0, A: 0 }, 20],
    ['staleness alone', { ...unit, S: 0, P: 0, U: 0 }, 10],
    ['each multiplier applied', { ...unit, W: 0.5, K: 0.8, R: 0.6, Z: 0.9, H: 0.8 }, 17.3],
  ])('%s scores %s', (_scenario, components, expected) => {
    expect(combine(components, DEFAULTS)).toBe(expected)
  })
})

describe('row order', () => {
  function row(id: string, initiative: string, score: number, W: number): ScoreRow {
    const components = { S: 0, P: 0, U: 0, A: 0, W, K: 1, R: 1, Z: 1, H: 1 }
    return { id, initiative, score, components } as ScoreRow
  }

  it.each([
    ['higher score first', row('B-9', 'b', 50, 0.5), row('A-1', 'a', 40, 1)],
    ['heavier initiative on a tie', row('B-9', 'b', 50, 1), row('A-1', 'a', 50, 0.5)],
    ['slug on a weight tie', row('A-9', 'a', 50, 1), row('B-1', 'b', 50, 1)],
    ['ID number, not text, on a slug tie', row('R-125', 'r', 57.5, 1), row('R-1000', 'r', 57.5, 1)],
    ['ID prefix before number', row('A-9', 'r', 50, 1), row('B-1', 'r', 50, 1)],
    [
      'ID number exactly, past 2^53',
      row('R-9007199254740992', 'r', 50, 1),
      row('R-09007199254740993', 'r', 50, 1),
    ],
    ['a numeric ID before a non-numeric suffix', row('A-10', 'r', 50, 1), row('A-1z', 'r', 50, 1)],
    ['slug by code point, not locale', row('X-1', 'Zeta', 50, 1), row('X-1', 'alpha', 50, 1)],
    ['slug by code point, not UTF-16 unit', row('X-1', '\u{FFFF}', 50, 1), row('X-1', '\u{10000}', 50, 1)],
  ])('%s', (_scenario, first, second) => {
    expect(compareRows(first, second)).toBeLessThan(0)
    expect(compareRows(second, first)).toBeGreaterThan(0)
  })

  it('orders any IDs totally, so every input order sorts the same', () => {
    const ids = ['A-2', 'A-10', 'A-1z', 'A-02', 'A-', 'a-1', 'B-1', '-1', 'A-1z2']
    const rows = ids.map(id => row(id, 'r', 50, 1))
    const expected = ['-1', 'A-02', 'A-2', 'A-10', 'B-1', 'a-1', 'A-', 'A-1z', 'A-1z2']
    for (let shift = 0; shift < rows.length; shift++) {
      const rotated = [...rows.slice(shift), ...rows.slice(0, shift)]
      expect(rotated.sort(compareRows).map(r => r.id)).toEqual(expected)
      expect(
        rotated
          .reverse()
          .sort(compareRows)
          .map(r => r.id),
      ).toEqual(expected)
    }
  })
})

describe('dispatchOrder', () => {
  interface Spec {
    id: string
    in?: string
    score: number
    W?: number
    kind?: string
    blocked?: string[]
  }
  function rows(specs: Spec[]): ScoreRow[] {
    return specs.map(s => ({
      id: s.id,
      initiative: s.in ?? 'a',
      score: s.score,
      kind: s.kind ?? 'platform',
      blocked: s.blocked ?? [],
      components: { S: 0, P: 0, U: 0, A: 0, W: s.W ?? 1, K: 1, R: 1, Z: 1, H: 1 },
    })) as ScoreRow[]
  }
  const nit = (id: string, score: number): Spec => ({ id, score, kind: 'nit' })

  it.each([
    [
      'decays a candidate once per prior pick in its initiative',
      rows([
        { id: 'A-1', score: 60 },
        { id: 'A-2', score: 55 },
        { id: 'B-1', in: 'b', score: 50 },
      ]),
      {},
      3,
      [
        ['A-1', 60],
        ['B-1', 50],
        ['A-2', 46.8],
      ],
      {},
    ],
    [
      'compounds decay over two prior picks',
      rows([
        { id: 'A-1', score: 100 },
        { id: 'A-2', score: 90 },
        { id: 'A-3', score: 80 },
        { id: 'B-1', in: 'b', score: 70 },
      ]),
      {},
      4,
      [
        ['A-1', 100],
        ['A-2', 76.5],
        ['B-1', 70],
        ['A-3', 57.8],
      ],
      {},
    ],
    [
      'does not decay a single initiative',
      rows([
        { id: 'A-1', score: 60 },
        { id: 'A-2', score: 55 },
      ]),
      {},
      2,
      [
        ['A-1', 60],
        ['A-2', 55],
      ],
      {},
    ],
    [
      'counts initiatives after blocked rows leave',
      rows([
        { id: 'A-1', score: 60 },
        { id: 'A-2', score: 55 },
        { id: 'B-1', in: 'b', score: 90, blocked: ['A-1'] },
      ]),
      {},
      3,
      [
        ['A-1', 60],
        ['A-2', 55],
      ],
      {},
    ],
    [
      'stops at n picks',
      rows([
        { id: 'A-1', score: 60 },
        { id: 'A-2', score: 55 },
        { id: 'A-3', score: 50 },
      ]),
      {},
      2,
      [
        ['A-1', 60],
        ['A-2', 55],
      ],
      {},
    ],
    [
      'caps a kind at floor(cap * n) and counts the skip',
      rows([nit('A-1', 90), nit('A-2', 80), nit('A-3', 70), { id: 'A-4', score: 10 }]),
      { nit: 0.5 },
      4,
      [
        ['A-1', 90],
        ['A-2', 80],
        ['A-4', 10],
      ],
      { 'share-cap:nit': 1 },
    ],
    [
      'allows at least one pick when floor(cap * n) is 0',
      rows([nit('A-1', 90), nit('A-2', 80), { id: 'A-3', score: 10 }]),
      { nit: 0.1 },
      3,
      [
        ['A-1', 90],
        ['A-3', 10],
      ],
      { 'share-cap:nit': 1 },
    ],
    [
      'does not decay an initiative for a skipped pick',
      rows([nit('A-1', 90), nit('A-2', 80), { id: 'B-1', in: 'b', score: 70 }, { id: 'A-3', score: 60 }]),
      { nit: 0.25 },
      4,
      [
        ['A-1', 90],
        ['B-1', 70],
        ['A-3', 51],
      ],
      { 'share-cap:nit': 1 },
    ],
    [
      'treats a cap of 1 or more as no cap',
      rows([nit('A-1', 90), nit('A-2', 80), nit('A-3', 70)]),
      { nit: 1.5 },
      3,
      [
        ['A-1', 90],
        ['A-2', 80],
        ['A-3', 70],
      ],
      {},
    ],
    [
      'ignores the discovery key',
      rows([
        { id: 'A-1', score: 90, kind: 'discovery' },
        { id: 'A-2', score: 80, kind: 'discovery' },
      ]),
      { discovery: 0.1 },
      2,
      [
        ['A-1', 90],
        ['A-2', 80],
      ],
      {},
    ],
    [
      'breaks an effective tie by the heavier initiative',
      rows([
        { id: 'A-1', score: 50, W: 0.5 },
        { id: 'B-1', in: 'b', score: 50, W: 1 },
      ]),
      {},
      1,
      [['B-1', 50]],
      {},
    ],
    [
      'breaks a weight tie by slug',
      rows([
        { id: 'B-1', in: 'b', score: 50 },
        { id: 'A-9', score: 50 },
      ]),
      {},
      1,
      [['A-9', 50]],
      {},
    ],
    [
      'breaks a slug tie by ID number',
      rows([
        { id: 'R-1000', score: 57.5 },
        { id: 'R-125', score: 57.5 },
      ]),
      {},
      1,
      [['R-125', 57.5]],
      {},
    ],
  ])('%s', (_scenario, input, shareCaps, n, expected, refused) => {
    const result = dispatchOrder(input, { ...DEFAULTS, share_caps: shareCaps }, n)
    expect(result.order.map(r => [r.id, r.effective])).toEqual(expected)
    expect(result.refused).toEqual(refused)
  })

  it('starts an initiative with prior picks at decay^k', () => {
    const input = rows([
      { id: 'A-1', score: 80 },
      { id: 'B-1', in: 'b', score: 70 },
    ])

    const result = dispatchOrder(input, { ...DEFAULTS, share_caps: {} }, 2, { a: 2 })

    expect(result.order.map(r => [r.id, r.effective])).toEqual([
      ['B-1', 70],
      ['A-1', 57.8],
    ])
  })

  it('orders exactly as before when prior picks are empty', () => {
    const input = rows([
      { id: 'A-1', score: 60 },
      { id: 'A-2', score: 55 },
      { id: 'B-1', in: 'b', score: 50 },
    ])
    const defaults = { ...DEFAULTS, share_caps: {} }

    expect(dispatchOrder(input, defaults, 3, {})).toEqual(dispatchOrder(input, defaults, 3))
  })
})

describe('scoreAll', () => {
  const tasks: ScoredTask[] = [
    task({
      id: 'A-1',
      title: 'Harden the token check',
      priority: 10,
      severity: 'critical',
      estimate: 2,
      done_when: 'Ship it.',
      created: '2026-08-01',
      tags: ['kind:security'],
    }),
    task({
      id: 'A-2',
      title: 'Add dashboard screen',
      priority: 20,
      severity: 'high',
      estimate: 5,
      done_when: 'Depends on A-1. Then deploy the thing.',
      updated: '2026-09-19',
      created: '2026-01-01',
      tags: [],
    }),
    task({ id: 'A-3', title: 'Fix typo in docs', priority: 20, created: '2026-09-29' }),
    task({ id: 'A-4', title: 'Owner call', priority: 30, tags: ['human-only'], notes: 'Blocked by A-3.' }),
    task({
      id: 'B-1',
      slug: 'b',
      title: 'Worktree budget',
      priority: 5,
      severity: 'low',
      estimate: 13,
      done_when: 'requires A-1 first',
      created: '2026-09-14',
    }),
    task({ id: 'B-2', slug: 'b', title: 'WIP spike on routing', priority: 6, estimate: 1, done_when: 'x' }),
    task({
      id: 'B-3',
      slug: 'b',
      title: 'Something',
      priority: 7,
      estimate: 1,
      done_when: 'x',
      created: 'soon',
    }),
  ]
  const result = scoreAll(
    tasks,
    { a: 1.0, b: 0.5 },
    DEFAULTS,
    { tags: [], titlePatterns: ['wip'] },
    ['deploy', 'config-edit'],
    TODAY,
  )

  it('ranks and scores exactly as score.py did on the same tasks', () => {
    const summary = result.rows.map(r => [
      r.id,
      r.score,
      r.kind,
      r.kindSource,
      r.blocked,
      r.stopShort,
      r.route,
    ])
    expect(summary).toEqual([
      ['A-1', 93.3, 'security', 'tag', [], [], 'implementer'],
      ['A-2', 9.2, 'product', 'regex', ['A-1'], ['deploy'], 'planner'],
      ['A-3', 8.1, 'nit', 'regex', [], [], 'triage'],
      ['B-3', 4.8, 'platform', 'default', [], [], 'implementer-lite'],
      ['B-1', 2.3, 'agent-tooling', 'regex', ['A-1'], [], 'planner'],
    ])
  })

  it('counts unblocks and age as score.py did', () => {
    expect(result.rows.map(r => [r.id, r.unblocks, r.ageDays])).toEqual([
      ['A-1', 2, 59],
      ['A-2', 0, 10],
      ['A-3', 1, 0],
      ['B-3', 0, 0],
      ['B-1', 0, 15],
    ])
  })

  it('counts refusals by kind', () => {
    expect(result.refused).toEqual({ 'excluded-tag': 1, 'excluded-pattern': 1 })
  })

  it.each([
    ['a seat tag', { tags: ['kind:security'] }, 'excluded-tag'],
    ['a reserved tag', { tags: ['needs-decision'] }, 'excluded-tag'],
    ['a tag before a pattern', { tags: ['blocked'], title: 'WIP' }, 'excluded-tag'],
    ['a title pattern, case-insensitively', { title: 'Draft: wiring' }, 'excluded-pattern'],
  ])('refuses %s', (_scenario, fields, kind) => {
    const exclusions = { tags: ['kind:security'], titlePatterns: ['^draft', 'wip'] }
    const { rows, refused } = scoreAll([task(fields)], { a: 1 }, DEFAULTS, exclusions, [], TODAY)
    expect(rows).toEqual([])
    expect(refused).toEqual({ [kind]: 1 })
  })

  it('throws for a task outside the seat scope', () => {
    expect(() =>
      scoreAll([task({ slug: 'elsewhere' })], { a: 1 }, DEFAULTS, { tags: [] }, [], TODAY),
    ).toThrow('no scope weight for initiative elsewhere')
  })
})
