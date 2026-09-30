import { describe, expect, it } from 'vitest'
import {
  dispatchedRow,
  foldDispatch,
  retiredRow,
  type DispatchRun,
  type DispatchSpend,
} from '../agents/seats/dispatch-record.js'

const RECORD_KEYS = [
  'ts',
  'task',
  'initiative',
  'kind',
  'score',
  'profile',
  'agent',
  'pr',
  'outcome',
  'note',
  'tokens',
  'usd_est',
  'value',
]

const run = (over: Partial<DispatchRun> = {}): DispatchRun => ({
  ts: '2026-02-03T04:05:00Z',
  task: 'AB-12',
  initiative: 'demo',
  kind: 'agent-tooling',
  profile: 'implementer',
  agent: 'sx-ab-12-fix',
  agent_id: 'id-1',
  spawner: 'seat-x',
  model: 'model-a',
  predecessor: null,
  ...over,
})

const spend = (tokens: number, usdEst: number | null): DispatchSpend => ({
  tokens,
  usd_est: usdEst,
  usage: { input: tokens, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 0 },
  models: ['model-a'],
  price_table: 1,
})

const dispatched = (over: Partial<DispatchRun> = {}) => dispatchedRow(run(over))

const retired = (
  sessionId: string,
  tokens = 1200,
  usdEst: number | null = 0.0123,
  over: Partial<DispatchRun> = {},
) => retiredRow(run({ ts: '2026-02-03T05:00:00Z', ...over }), sessionId, spend(tokens, usdEst))

const seatRow = (over: Record<string, unknown> = {}) => ({
  ts: '2026-02-03T05:30:00Z',
  agent: 'sx-ab-12-fix',
  outcome: 'merged',
  value: 3,
  pr: 7,
  ...over,
})

const fold = (...rows: object[]) => foldDispatch(rows.map(row => JSON.stringify(row)).join('\n') + '\n')

describe('broker rows', () => {
  it.each([
    ['dispatched', dispatched()],
    ['retired', retired('s-1')],
    ['retired without a usage read', retiredRow(run(), 's-1', { usage_miss: 'no transcript written' })],
  ])('the %s row carries every record key, by and agent_id', (_name, row) => {
    expect(Object.keys(row)).toEqual(expect.arrayContaining([...RECORD_KEYS, 'by', 'agent_id']))
    expect(row.by).toBe('broker')
    expect(row.agent_id).toBe('id-1')
  })

  it('takes the task it is given', () => {
    expect(dispatched({ task: 'AB-99' }).task).toBe('AB-99')
    expect(dispatched({ task: null }).task).toBeNull()
  })

  it('leaves the spend and every seat-owned key null at dispatch', () => {
    expect(dispatched()).toMatchObject({
      outcome: 'dispatched',
      score: null,
      pr: null,
      note: null,
      value: null,
      tokens: null,
      usd_est: null,
    })
  })

  it('writes the spend and its session on the retired row', () => {
    expect(retired('s-1', 1200, 0.0123)).toMatchObject({
      outcome: 'retired',
      tokens: 1200,
      usd_est: 0.0123,
      session_id: 's-1',
      models: ['model-a'],
      price_table: 1,
    })
  })

  it('writes the reason in place of the spend when the usage read failed', () => {
    const row = retiredRow(run(), 's-1', { usage_miss: 'no transcript written' })
    expect(row).toMatchObject({
      outcome: 'retired',
      tokens: null,
      usd_est: null,
      usage_miss: 'no transcript written',
    })
    expect(row).not.toHaveProperty('usage')
  })
})

describe('foldDispatch', () => {
  const merged = {
    ts: '2026-02-03T04:05:00Z',
    task: 'AB-12',
    initiative: 'demo',
    kind: 'agent-tooling',
    score: null,
    profile: 'implementer',
    agent: 'sx-ab-12-fix',
    pr: 7,
    outcome: 'merged',
    note: null,
    tokens: 1200,
    usd_est: 0.0123,
    usage_partial: false,
    value: 3,
    agent_id: 'id-1',
    spawner: 'seat-x',
    model: 'model-a',
    predecessor: null,
  }

  it("folds the seat's outcome row to one record whether it precedes or follows the broker's retired row", () => {
    const seatFirst = fold(dispatched(), seatRow(), retired('s-1'))
    const brokerFirst = fold(dispatched(), retired('s-1'), seatRow())

    expect(seatFirst).toEqual({ records: [merged], malformed: 0, invalid_outcomes: 0 })
    expect(brokerFirst).toEqual(seatFirst)
  })

  it("keeps the broker's spend when a seat row carries null or its own tokens", () => {
    const nulls = fold(dispatched(), retired('s-1'), seatRow({ tokens: null, usd_est: null }))
    const guesses = fold(dispatched(), retired('s-1'), seatRow({ tokens: 5, usd_est: 9 }))

    expect(nulls.records).toEqual([merged])
    expect(guesses.records).toEqual([merged])
  })

  it('reads retired when the broker retired the agent and the seat wrote no outcome', () => {
    const { records } = fold(dispatched(), retired('s-1'))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'retired', value: null, tokens: 1200 })
  })

  it('reads dispatched while the agent is still running', () => {
    expect(fold(dispatched()).records[0]).toMatchObject({
      outcome: 'dispatched',
      tokens: null,
      usd_est: null,
    })
  })

  it.each([
    ['after', [dispatched(), seatRow({ outcome: 'dispatched', value: null, pr: null })]],
    ['before', [seatRow({ outcome: 'dispatched', value: null, pr: null }), dispatched()]],
  ])("merges a seat's own dispatched row written %s the broker's into one group", (_name, rows) => {
    const { records } = fold(...rows, retired('s-1'), seatRow())

    expect(records).toEqual([merged])
  })

  it('reads a reused name with a new agent_id as a second record', () => {
    const { records } = fold(
      dispatched(),
      retired('s-1'),
      seatRow(),
      dispatched({ agent_id: 'id-2', ts: '2026-02-04T00:00:00Z' }),
      retired('s-2', 300, 0.002, { agent_id: 'id-2' }),
    )

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ agent_id: 'id-1', outcome: 'merged', tokens: 1200 })
    expect(records[1]).toMatchObject({ agent_id: 'id-2', outcome: 'retired', tokens: 300, value: null })
  })

  it('reads a new agent_id as a second record when the first run left no retired row', () => {
    const { records } = fold(
      dispatched(),
      dispatched({ agent_id: 'id-2' }),
      retired('s-2', 300, 0.002, { agent_id: 'id-2' }),
    )

    expect(records.map(r => [r.agent_id, r.outcome, r.tokens])).toEqual([
      ['id-1', 'dispatched', null],
      ['id-2', 'retired', 300],
    ])
  })

  it('keeps two agents apart when their rows interleave', () => {
    const other = { agent: 'sx-ab-13-docs', agent_id: 'id-9', task: 'AB-13' }
    const { records } = fold(
      dispatched(),
      dispatched(other),
      retired('s-9', 40, 0.001, other),
      retired('s-1'),
      seatRow({ agent: 'sx-ab-13-docs', outcome: 'done', value: 1, pr: null }),
    )

    expect(records.map(r => [r.agent, r.task, r.outcome, r.tokens])).toEqual([
      ['sx-ab-12-fix', 'AB-12', 'retired', 1200],
      ['sx-ab-13-docs', 'AB-13', 'done', 40],
    ])
  })

  it('counts a session retired twice once, by its last read', () => {
    const { records } = fold(dispatched(), retired('s-1', 1200, 0.0123), retired('s-1', 1500, 0.02))

    expect(records[0]).toMatchObject({ tokens: 1500, usd_est: 0.02 })
  })

  it('sums the retired rows of two sessions', () => {
    const { records } = fold(dispatched(), retired('s-1', 1200, 0.0123), retired('s-2', 300, 0.002))

    expect(records[0]).toMatchObject({ tokens: 1500, usd_est: 0.0143 })
  })

  it('keeps an earlier read when a later retire of the session failed to read its usage', () => {
    const miss = retiredRow(run(), 's-1', { usage_miss: 'no transcript written' })

    expect(fold(dispatched(), retired('s-1'), miss).records[0]).toMatchObject({
      tokens: 1200,
      usd_est: 0.0123,
    })
  })

  it('gives no usd_est when one summed session is unpriced, and still sums the tokens', () => {
    const { records } = fold(dispatched(), retired('s-1', 1200, 0.0123), retired('s-2', 300, null))

    expect(records[0]).toMatchObject({ tokens: 1500, usd_est: null })
  })

  it('ignores and counts a seat outcome outside the end states', () => {
    const folded = fold(dispatched(), retired('s-1'), seatRow({ outcome: 'shipped' }))

    expect(folded.invalid_outcomes).toBe(1)
    expect(folded.records).toEqual([{ ...merged, outcome: 'retired' }])
  })

  it("counts a seat's retired as invalid: only the broker writes it", () => {
    const folded = fold(dispatched(), seatRow({ outcome: 'retired' }))

    expect(folded.invalid_outcomes).toBe(1)
    expect(folded.records[0]?.outcome).toBe('dispatched')
  })

  it('keeps an earlier end state when a later seat row has an invalid outcome', () => {
    const folded = fold(dispatched(), seatRow({ outcome: 'parked' }), seatRow({ outcome: 'shipped' }))

    expect(folded.records[0]?.outcome).toBe('parked')
    expect(folded.invalid_outcomes).toBe(1)
  })

  it('takes the last end state a seat wrote', () => {
    const folded = fold(dispatched(), seatRow({ outcome: 'parked', value: null }), retired('s-1'), seatRow())

    expect(folded.records[0]).toMatchObject({ outcome: 'merged', value: 3 })
    expect(folded.invalid_outcomes).toBe(0)
  })

  it('skips and counts a malformed line', () => {
    const text = [
      JSON.stringify(dispatched()),
      '{"agent":"sx-ab-12-fix","outcome":',
      '["sx-ab-12-fix"]',
      '{"outcome":"merged"}',
      '',
      JSON.stringify(retired('s-1')),
    ].join('\n')

    const folded = foldDispatch(text)

    expect(folded.malformed).toBe(3)
    expect(folded.records).toHaveLength(1)
    expect(folded.records[0]).toMatchObject({ outcome: 'retired', tokens: 1200 })
  })

  it("lets a seat's task, initiative and kind win over the broker's", () => {
    const { records } = fold(
      dispatched({ task: null }),
      seatRow({ task: 'AB-14', kind: 'docs' }),
      retired('s-1'),
    )

    expect(records[0]).toMatchObject({ task: 'AB-14', kind: 'docs', initiative: 'demo' })
  })

  it('reads a group with no broker row from the seat rows alone', () => {
    const { records } = fold(
      seatRow({
        outcome: 'dispatched',
        profile: 'implementer',
        value: null,
        pr: null,
        ts: '2026-02-03T04:00:00Z',
      }),
      seatRow({ outcome: 'done', tokens: 900, usd_est: 0.5, note: 'no PR needed', pr: null }),
    )

    expect(records).toEqual([
      {
        ...merged,
        ts: '2026-02-03T04:00:00Z',
        task: null,
        initiative: null,
        kind: null,
        pr: null,
        outcome: 'done',
        note: 'no PR needed',
        tokens: 900,
        usd_est: 0.5,
        agent_id: null,
        spawner: null,
        model: null,
      },
    ])
  })

  it('joins a retired row to the run with its agent_id, not the latest of the name', () => {
    const { records } = fold(
      dispatched(),
      dispatched({ agent_id: 'id-2' }),
      retired('s1', 10, 0.001, { agent_id: 'id-1' }),
      retired('s2', 20, 0.002, { agent_id: 'id-2' }),
    )

    expect(records.map(r => [r.agent_id, r.tokens])).toEqual([
      ['id-1', 10],
      ['id-2', 20],
    ])
  })

  it('joins a retired row with no agent_id to the latest run of the name', () => {
    const noId = { ...retired('s-2', 20, 0.002), agent_id: null }
    const { records } = fold(dispatched(), dispatched({ agent_id: 'id-2' }), noId)

    expect(records.map(r => [r.agent_id, r.tokens])).toEqual([
      ['id-1', null],
      ['id-2', 20],
    ])
  })

  it("opens no new record for a seat's dispatched row written after the broker's retired row", () => {
    const seatDispatched = seatRow({ outcome: 'dispatched', value: null, pr: null })
    const folded = fold(dispatched(), retired('s-1'), seatDispatched, seatRow())

    expect(folded).toEqual({ records: [merged], malformed: 0, invalid_outcomes: 0 })
  })

  it.each([
    ['a seat outcome', [dispatched(), retired('s-1'), seatRow()]],
    ['a retire of the same agent_id', [dispatched(), retired('s-1')]],
  ])('opens a new record for a broker dispatched row once the run ended by %s', (_name, ended) => {
    const { records } = fold(...ended, dispatched({ ts: '2026-02-04T00:00:00Z' }))

    expect(records.map(r => r.outcome).at(-1)).toBe('dispatched')
    expect(records).toHaveLength(2)
  })

  it("opens a new record for a seat's dispatched row once a seat outcome ended the run", () => {
    const seatDispatched = seatRow({ outcome: 'dispatched', value: null, pr: null })
    const { records } = fold(dispatched(), retired('s-1'), seatRow(), seatDispatched)

    expect(records).toHaveLength(2)
  })

  it('flags usage_partial when a session read missed and its tokens are left out', () => {
    const miss = retiredRow(run(), 's-2', { usage_miss: 'no transcript written' })
    const { records } = fold(dispatched(), retired('s-1', 1200, 0.0123), miss)

    expect(records[0]).toMatchObject({ tokens: 1200, usage_partial: true })
  })

  it('flags usage_partial with null tokens when every read missed', () => {
    const miss = retiredRow(run(), 's-1', { usage_miss: 'no transcript written' })

    expect(fold(dispatched(), miss).records[0]).toMatchObject({ tokens: null, usage_partial: true })
  })

  it('does not flag usage_partial when a later miss follows an earlier read of the same session', () => {
    const miss = retiredRow(run(), 's-1', { usage_miss: 'no transcript written' })

    expect(fold(dispatched(), retired('s-1'), miss).records[0]?.usage_partial).toBe(false)
  })

  it('reads a seat-only usd_est that is not a finite number as null', () => {
    const { records } = fold(seatRow({ outcome: 'done', tokens: 5, usd_est: 'free' }))

    expect(records[0]).toMatchObject({ tokens: 5, usd_est: null })
  })

  it('attaches a broker retire to the latest run when no row of its name carries its agent_id', () => {
    const legacy = seatRow({ outcome: 'dispatched', value: null, pr: null })
    const { records } = fold(legacy, retired('s-1', 1200, 0.0123, { agent_id: 'id-A' }))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tokens: 1200, agent_id: 'id-A' })
  })

  it('matches a retire to the run that holds its agent_id even when another row of that run has none', () => {
    const legacy = seatRow({ outcome: 'dispatched', value: null, pr: null })
    const { records } = fold(
      legacy,
      dispatched({ agent_id: 'id-A' }),
      seatRow(),
      dispatched({ agent_id: 'id-B' }),
      retired('s-1', 1200, 0.0123, { agent_id: 'id-A' }),
    )

    expect(records.map(r => [r.agent_id, r.tokens])).toEqual([
      ['id-A', 1200],
      ['id-B', null],
    ])
  })

  it('matches a retire to the latest run when an agent_id is reused', () => {
    const { records } = fold(
      dispatched({ agent_id: 'id-A' }),
      seatRow(),
      dispatched({ agent_id: 'id-A' }),
      retired('s-1', 1200, 0.0123, { agent_id: 'id-A' }),
    )

    expect(records.map(r => r.tokens)).toEqual([null, 1200])
  })

  it('folds an empty file to no records', () => {
    expect(foldDispatch('')).toEqual({ records: [], malformed: 0, invalid_outcomes: 0 })
  })
})
