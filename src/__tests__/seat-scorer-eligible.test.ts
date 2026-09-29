import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scorerEligible } from '../agents/seats/io.js'

/** CC-297: the watchdog's eligible count comes from the in-process scorer, not score.py. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const read = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')

/** `python3 score.py --seat sample-seat --top 1000 --json --tasks-json tasks.json --today 2026-09-29`, len(order). */
const SCORE_PY_ELIGIBLE = 55

interface FixtureTask {
  id: string
  slug: string
}

let tmp: string
let autonomy: string
let activeWork: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-eligible-'))
  autonomy = path.join(tmp, 'autonomy')
  activeWork = path.join(tmp, 'active-work')
  fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
  fs.writeFileSync(
    path.join(autonomy, 'charter.md'),
    read('charter.md').replace(/^seats:.*$/m, 'seats: [sample-seat]'),
  )
  fs.writeFileSync(path.join(autonomy, 'seats', 'sample-seat.md'), read('seats/sample-seat.md'))
  const { tasks } = JSON.parse(read('tasks.json')) as { tasks: FixtureTask[] }
  for (const task of tasks) {
    const dir = path.join(activeWork, task.slug, 'tasks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${task.id}.yml`), stringify(task))
    fs.writeFileSync(path.join(activeWork, task.slug, 'brief.md'), '---\nstate: focused\n---\n')
  }
})

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('scorerEligible', () => {
  it('counts the same eligible tasks as score.py for the synthetic sample seat', () => {
    expect(scorerEligible(autonomy, 'sample-seat', { activeWork, today: '2026-09-29' })).toBe(
      SCORE_PY_ELIGIBLE,
    )
  })

  it('is undefined when the seat file is missing', () => {
    fs.rmSync(path.join(autonomy, 'seats', 'sample-seat.md'))
    expect(scorerEligible(autonomy, 'sample-seat', { activeWork, today: '2026-09-29' })).toBeUndefined()
  })

  it('is undefined when the seat file does not parse', () => {
    fs.writeFileSync(path.join(autonomy, 'seats', 'sample-seat.md'), '---\ninitiatives: [oops\n---\n')
    expect(scorerEligible(autonomy, 'sample-seat', { activeWork, today: '2026-09-29' })).toBeUndefined()
  })
})
