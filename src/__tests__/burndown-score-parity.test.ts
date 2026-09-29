import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mergeDefaults, parseCharter, parseSeat } from '../agents/burndown/policy.js'
import { tasksFromList } from '../agents/burndown/score-source.js'
import { dispatchOrder, scoreAll } from '../agents/burndown/score.js'

/** CC-229: the TS scorer reproduces score.py's titan-coord ranking over a frozen backlog. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const read = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')

interface ExpectedRow {
  id: string
  score: number
  effective: number
  kind: string
}

interface Expected {
  order: ExpectedRow[]
  refused: Record<string, number>
  initiatives: Record<string, number>
}

function rankFixture() {
  const snapshot = JSON.parse(read('tasks.json')) as { today: string }
  const expected = JSON.parse(read('expected-titan-coord.json')) as Expected
  const charter = parseCharter(read('charter.md'))
  const seat = parseSeat(read('titan-coord.md'), 'titan-coord')
  const defaults = mergeDefaults(charter, seat)
  const exclusions = { tags: seat.excluded_tags, titlePatterns: seat.excluded_title_patterns }
  const scored = scoreAll(
    tasksFromList(snapshot),
    expected.initiatives,
    defaults,
    exclusions,
    charter.hard_stops,
    snapshot.today,
  )
  const dispatched = dispatchOrder(scored.rows, defaults, expected.order.length)
  return { expected, scored, dispatched }
}

const pick = ({ id, score, effective }: { id: string; score: number; effective: number }) => ({
  id,
  score,
  effective,
})

describe('score.py parity on the 2026-09-29 titan-coord backlog', () => {
  const { expected, scored, dispatched } = rankFixture()

  it('ranks the same top 10 with the same scores and effective values', () => {
    expect(expected.order).toHaveLength(10)
    expect(dispatched.order.map(pick)).toEqual(expected.order.map(pick))
  })

  it('refuses the same tasks for the same reasons', () => {
    expect(scored.refused).toEqual(expected.refused)
  })

  it('holds no agent-tooling or nit task in the top 10, so share caps stay inert', () => {
    const capped = ['agent-tooling', 'nit']
    expect(expected.order.filter(row => capped.includes(row.kind))).toEqual([])
    expect(dispatched.order.filter(row => capped.includes(row.kind))).toEqual([])
    expect(dispatched.refused).toEqual({})
  })
})
