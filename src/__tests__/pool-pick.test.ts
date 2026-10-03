import { describe, expect, it } from 'vitest'
import { parseFunds, seatInitiatives, seatPools, type FundsMap, type Pool } from '../agents/seats/charter.js'
import { parsePace, type PaceRead } from '../agents/seats/pace-file.js'
import { pickPool, type PoolPickInput } from '../agents/seats/pool-pick.js'

const NOW = Date.parse('2026-01-05T12:00:00Z')
const MINUTE = 60_000

const pool = (name: string, ceiling = 100): Pool => ({
  name,
  configDir: `/synthetic/${name}`,
  humanUses: false,
  rule: { reserve_seven_day: 14, ceiling_five_hour: ceiling },
})

const POOLS = [pool('alpha'), pool('beta'), pool('gamma')]
const OPEN_FUNDS: FundsMap = { only: new Map(), never: [] }

interface Row {
  behind: number
  ageMinutes?: number
  fiveHour?: number
  resetsAt?: string
}

const pace = (rows: Record<string, Row>): PaceRead =>
  parsePace(
    JSON.stringify({
      at: new Date(NOW).toISOString(),
      pools: Object.fromEntries(
        Object.entries(rows).map(([name, row]) => [
          name,
          {
            behind: row.behind,
            reading: {
              at: new Date(NOW - (row.ageMinutes ?? 1) * MINUTE).toISOString(),
              seven_day: 40,
              five_hour: row.fiveHour ?? 20,
            },
            resets_at: row.resetsAt ?? '2026-01-09T12:00:00Z',
          },
        ]),
      ),
    }),
  )

const input = (rows: Record<string, Row>, over: Partial<PoolPickInput> = {}): PoolPickInput => ({
  pinned: false,
  home: 'alpha',
  pools: POOLS,
  funds: OPEN_FUNDS,
  initiatives: [],
  pace: pace(rows),
  trusted: () => true,
  now: NOW,
  ...over,
})

describe('the pool pick for an unpinned seat spawn', () => {
  it('orders the pools by how far each is behind pace', () => {
    const pick = pickPool(input({ alpha: { behind: 2 }, beta: { behind: 12 }, gamma: { behind: 7 } }))

    expect(pick.order).toEqual(['beta', 'gamma', 'alpha'])
    expect(pick.reason).toBe('beta is most behind pace (12)')
  })

  it('breaks a tie with the earlier reset', () => {
    const pick = pickPool(
      input({
        alpha: { behind: 8, resetsAt: '2026-01-09T12:00:00Z' },
        beta: { behind: 8, resetsAt: '2026-01-07T12:00:00Z' },
      }),
    )

    expect(pick.order).toEqual(['beta', 'alpha'])
  })

  it('keeps the home pool first when no pool is behind by 5', () => {
    const pick = pickPool(input({ alpha: { behind: 1 }, beta: { behind: 4 }, gamma: { behind: -3 } }))

    expect(pick.order).toEqual(['alpha', 'beta', 'gamma'])
    expect(pick.reason).toContain('home pool alpha keeps the spawn')
  })

  it('skips a pool whose reading is over 15 minutes old', () => {
    const pick = pickPool(input({ alpha: { behind: 2 }, beta: { behind: 30, ageMinutes: 16 } }))

    expect(pick.order).toEqual(['alpha'])
    expect(pick.candidates).toContainEqual({ pool: 'beta', behind: 30, skip: 'reading 960s old, over 900s' })
  })

  it('keeps a pool whose reading is exactly 15 minutes old', () => {
    const pick = pickPool(input({ beta: { behind: 30, ageMinutes: 15 } }))

    expect(pick.order).toEqual(['beta'])
  })

  it('skips a pool within 10 points of its five_hour ceiling', () => {
    const rows = {
      alpha: { behind: 2 },
      beta: { behind: 30, fiveHour: 90 },
      gamma: { behind: 9, fiveHour: 89 },
    }

    const pick = pickPool(input(rows))

    expect(pick.order).toEqual(['gamma', 'alpha'])
    expect(pick.candidates).toContainEqual({
      pool: 'beta',
      behind: 30,
      skip: 'five_hour 90% within 10 of ceiling 100%',
    })
  })

  it('measures the five_hour margin from each pool’s own ceiling', () => {
    const pools = [pool('alpha'), pool('beta', 85)]

    const pick = pickPool(input({ alpha: { behind: 2 }, beta: { behind: 30, fiveHour: 76 } }, { pools }))

    expect(pick.order).toEqual(['alpha'])
  })

  it('skips a pool whose config dir does not trust the cwd', () => {
    const pick = pickPool(
      input({ alpha: { behind: 2 }, beta: { behind: 30 } }, { trusted: p => p.name !== 'beta' }),
    )

    expect(pick.order).toEqual(['alpha'])
  })

  it('routes nothing when the spawn pins a config_dir', () => {
    const pick = pickPool(input({ beta: { behind: 30 } }, { pinned: true }))

    expect(pick).toEqual({ order: [], reason: 'the spawn pins config_dir', candidates: [] })
  })

  it('routes nothing when pace.json is missing', () => {
    const pick = pickPool(input({}, { pace: { found: false, reason: 'pace.json is missing' } }))

    expect(pick).toEqual({ order: [], reason: 'pace.json is missing', candidates: [] })
  })

  it('routes nothing when every reading is stale', () => {
    const pick = pickPool(
      input({ alpha: { behind: 9, ageMinutes: 40 }, beta: { behind: 30, ageMinutes: 40 } }),
    )

    expect(pick.order).toEqual([])
    expect(pick.reason).toBe('no pool is eligible')
  })

  it('routes nothing when the charter has no funds map', () => {
    const pick = pickPool(input({ beta: { behind: 30 } }, { funds: undefined }))

    expect(pick.order).toEqual([])
    expect(pick.reason).toBe('the charter has no funds map')
  })
})

describe('the funds map in the pool pick', () => {
  const funds: FundsMap = {
    only: new Map([['private-work', ['gamma']]]),
    fallback: ['alpha', 'beta', 'gamma'],
    never: ['family'],
  }
  const rows = { alpha: { behind: 2 }, beta: { behind: 30 }, gamma: { behind: 6 } }

  it('bills restricted work only to the pool the map names', () => {
    const pick = pickPool(input(rows, { funds, initiatives: ['private-work'] }))

    expect(pick.order).toEqual(['gamma'])
    expect(pick.candidates).toContainEqual({
      pool: 'beta',
      behind: 30,
      skip: 'not in the funds map for this work',
    })
  })

  it('lets any fallback pool fund an initiative the map does not name', () => {
    const pick = pickPool(input(rows, { funds, initiatives: ['open-work'] }))

    expect(pick.order).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('needs a pool to fund every initiative the spawn may belong to', () => {
    const pick = pickPool(input(rows, { funds, initiatives: ['open-work', 'private-work'] }))

    expect(pick.order).toEqual(['gamma'])
  })

  it('never routes a human-only initiative', () => {
    const pick = pickPool(input(rows, { funds, initiatives: ['family'] }))

    expect(pick).toEqual({ order: [], reason: 'initiative family is human-only', candidates: [] })
  })
})

describe('charter and seat fields the pool pick reads', () => {
  const charter = [
    '---',
    'seats: [alpha-coord]',
    'human_only_initiatives: [family, taxes,',
    '  garden]',
    'funds:',
    '  default: [alpha, beta]',
    '  private-work: [gamma]   # stays on its own account',
    'pools:',
    '  alpha: {config_dir: /synthetic/alpha, reserve_seven_day: 14, ceiling_five_hour: 100}',
    '---',
    '# Charter',
  ].join('\n')

  it('parses the funds block, its default and the wrapped human-only list', () => {
    expect(parseFunds(charter)).toEqual({
      only: new Map([['private-work', ['gamma']]]),
      fallback: ['alpha', 'beta'],
      never: ['family', 'taxes', 'garden'],
    })
  })

  it('reads a charter without a funds block as no map', () => {
    expect(parseFunds('---\nseats: [alpha-coord]\n---\n')).toBeUndefined()
  })

  it('reads the seat file’s pools list and initiative slugs', () => {
    const seat =
      '---\nprefix: ac\npool: alpha\npools: [alpha, beta]\ninitiatives:\n  open-work: 1.0\n  private-work: 0.7\n---\n'

    expect(seatPools(seat)).toEqual(['alpha', 'beta'])
    expect(seatInitiatives(seat)).toEqual(['open-work', 'private-work'])
    expect(seatPools('---\nprefix: ac\npool: alpha\n---\n')).toBeUndefined()
  })
})

describe('the pace file reader', () => {
  it('reads epoch seconds, epoch ms and ISO times as epoch ms', () => {
    const read = parsePace(
      JSON.stringify({
        pools: {
          alpha: { behind: 3, reading: { at: NOW / 1000, five_hour: 5 }, resets_at: NOW + MINUTE },
          beta: { behind: -2, reading: { at: new Date(NOW).toISOString() } },
        },
      }),
    )

    expect(read).toEqual({
      found: true,
      pools: new Map([
        ['alpha', { behind: 3, readingAt: NOW, fiveHour: 5, resetsAt: NOW + MINUTE }],
        ['beta', { behind: -2, readingAt: NOW }],
      ]),
    })
  })

  it('leaves out a row with no deficit or reading time, and skips that pool in the pick', () => {
    const read = parsePace(JSON.stringify({ pools: { alpha: { behind: 'far' }, beta: { reading: {} } } }))

    expect(read).toEqual({ found: true, pools: new Map() })
    expect(pickPool(input({}, { pace: read })).candidates).toContainEqual({
      pool: 'alpha',
      skip: 'no pace row',
    })
  })

  it('reports text that is not JSON, or has no pools, as not found', () => {
    expect(parsePace('{')).toEqual({ found: false, reason: 'pace.json is not JSON' })
    expect(parsePace('[]')).toEqual({ found: false, reason: 'pace.json has no pools' })
  })
})
