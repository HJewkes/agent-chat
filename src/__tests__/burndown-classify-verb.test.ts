import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offPlanIdsOf } from '../agents/burndown/off-plan.js'
import { parseClassFile } from '../agents/burndown/plan-class.js'
import type { ClassRow, OwnerAnswer } from '../agents/burndown/plan-class.js'
import { classifyFromDisk, renderClassify, type AskPorts } from '../cli/verbs/burndown-classify.js'

const PLAN = [
  '# Factory plan',
  '',
  '## 2. Section two',
  '',
  '| P | items |',
  '|---|---|',
  '| P3 | TP-10 |',
  '',
  '## 3. Later',
  '',
].join('\n')

const NOW = new Date(2026, 9, 14, 9, 0, 0)

let dir: string
let root: string
let planPath: string
let outDir: string

const task = (id: string, fields: Record<string, string>): void => {
  const body = Object.entries({ id, title: `${id} work`, status: 'open', ...fields })
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  fs.writeFileSync(path.join(root, 'titan-platform', 'tasks', `${id}.yml`), `${body}\ntags: []\n`)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-classify-'))
  root = path.join(dir, 'aw')
  outDir = path.join(dir, 'review')
  planPath = path.join(dir, 'plan.md')
  fs.mkdirSync(path.join(root, 'titan-platform', 'tasks'), { recursive: true })
  fs.writeFileSync(planPath, PLAN)
  task('TP-10', {})
  task('TP-11', {})
  task('TP-12', { title: 'TP-10 follow-up: tidy' })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const run = (write: boolean, asks?: AskPorts, now = NOW) =>
  classifyFromDisk({ planPath, initiatives: ['titan-platform'], root, outDir, write, now }, asks)

describe('burndown classify (TP-2418 b)', () => {
  it('classifies every open task, untagged ones too, and writes the dated v1 file', async () => {
    const result = await run(true)

    const file = path.join(outDir, 'off-plan-2026-10-14.md')
    expect(result.written).toBe(file)
    expect(renderClassify(result)).toEqual([
      'on 1 off 1 ambiguous 1',
      '  P3 1',
      'off TP-11 (titan-platform): no section-2 id or link',
      'ambiguous TP-12 (titan-platform): mentions TP-10',
      `wrote ${file}`,
    ])
    const text = fs.readFileSync(file, 'utf8')
    expect(parseClassFile(text)?.map(row => [row.class, row.id, row.detail])).toEqual([
      ['on', 'TP-10', 'P3'],
      ['off', 'TP-11', 'no section-2 id or link'],
      ['ambiguous', 'TP-12', 'mentions TP-10'],
    ])
    expect(offPlanIdsOf(text)).toEqual(new Set(['TP-11', 'TP-12']))
    expect(fs.readdirSync(outDir)).toEqual(['off-plan-2026-10-14.md'])
  })

  it('writes nothing on a dry run', async () => {
    const result = await run(false)

    expect(result.rows).toHaveLength(3)
    expect(renderClassify(result).at(-1)).toBe('dry run: nothing written (pass --write)')
    expect(fs.existsSync(outDir)).toBe(false)
  })

  it('refuses a plan without section 2 and writes no file', async () => {
    fs.writeFileSync(planPath, '# Factory plan\n\n## 3. Later\n')

    await expect(run(true)).rejects.toThrow(/no "## 2\." section/)
    expect(fs.existsSync(outDir)).toBe(false)
  })

  it('leaves closed tasks out', async () => {
    task('TP-13', { status: 'done' })

    expect((await run(false)).rows.map(row => row.id)).toEqual(['TP-10', 'TP-11', 'TP-12'])
  })

  it('overwrites the same day file on a second run', async () => {
    await run(true)
    task('TP-14', {})

    await run(true)

    const text = fs.readFileSync(path.join(outDir, 'off-plan-2026-10-14.md'), 'utf8')
    expect(parseClassFile(text)?.map(row => row.id)).toEqual(['TP-10', 'TP-11', 'TP-12', 'TP-14'])
  })
})

/** Stands in for the broker: records asks, numbers them, and answers from a table. */
function fakeAsks(answers: Record<string, string> = {}): AskPorts & { asked: ClassRow[] } {
  const asked: ClassRow[] = []
  return {
    asked,
    async ask(row) {
      asked.push(row)
      return `m-${row.id}`
    },
    async answers(askIds) {
      const found = new Map<string, OwnerAnswer>()
      for (const id of askIds)
        if (answers[id] !== undefined)
          found.set(id, { msgId: `a-${id}`, outcome: 'answered', text: answers[id] })
      return found
    },
  }
}

const rowOf = (result: { rows: ClassRow[] }, id: string) => result.rows.find(row => row.id === id)
const fileRows = (date = '2026-10-14') =>
  parseClassFile(fs.readFileSync(path.join(outDir, `off-plan-${date}.md`), 'utf8')) ?? []

describe('burndown classify --ask (TP-2418 c)', () => {
  // Mutation caught: re-asking an ambiguous task every run.
  it('asks once per ambiguous task, two-way on/off, and records the ask in the file', async () => {
    const asks = fakeAsks()

    await run(true, asks)
    await run(true, asks, new Date(2026, 9, 15, 9, 0, 0))

    expect(asks.asked.map(row => row.id)).toEqual(['TP-12'])
    expect(fileRows('2026-10-15').find(row => row.id === 'TP-12')?.ask).toBe('m-TP-12')
    expect(fileRows('2026-10-15').find(row => row.id === 'TP-11')?.ask).toBe('-')
  })

  // Mutation caught: treating no answer as on, or ignoring a carried answer.
  it('applies an on answer citing it, and keeps an unanswered row ambiguous', async () => {
    task('TP-13', { title: 'TP-10 docs' })
    await run(true, fakeAsks())

    const result = await run(true, fakeAsks({ 'm-TP-12': 'on' }))

    expect(rowOf(result, 'TP-12')).toMatchObject({
      class: 'on',
      detail: 'owner answered a-m-TP-12',
      ask: 'm-TP-12',
    })
    expect(rowOf(result, 'TP-13')).toMatchObject({
      class: 'ambiguous',
      detail: 'mentions TP-10',
      ask: 'm-TP-13',
    })
    expect(offPlanIdsOf(fs.readFileSync(path.join(outDir, 'off-plan-2026-10-14.md'), 'utf8'))).toEqual(
      new Set(['TP-11', 'TP-13']),
    )
  })

  it('applies an off answer citing it', async () => {
    await run(true, fakeAsks())

    const result = await run(true, fakeAsks({ 'm-TP-12': 'off' }))

    expect(rowOf(result, 'TP-12')).toMatchObject({ class: 'off', detail: 'owner answered a-m-TP-12' })
  })

  // Mutation caught: throwing before the write when the broker is down.
  it('still writes the file with not-sent when the broker is down, and the next run retries', async () => {
    const down: AskPorts = {
      ask: () => Promise.reject(new Error('broker unavailable')),
      answers: () => Promise.reject(new Error('broker unavailable')),
    }

    const result = await run(true, down)
    const retry = fakeAsks()
    await run(true, retry)

    expect(result.warnings).toEqual([expect.stringMatching(/owner asks not sent.*broker unavailable/)])
    expect(rowOf(result, 'TP-12')).toMatchObject({ class: 'ambiguous', ask: 'not-sent' })
    expect(retry.asked.map(row => row.id)).toEqual(['TP-12'])
  })

  // Mutation caught: removing the per-run cap.
  it('sends at most 5 asks a run', async () => {
    for (const n of [20, 21, 22, 23, 24, 25]) task(`TP-${n}`, { title: `TP-10 part ${n}` })
    const asks = fakeAsks()

    const result = await run(true, asks)

    expect(asks.asked).toHaveLength(5)
    expect(result.rows.filter(row => row.class === 'ambiguous' && row.ask === '-')).toHaveLength(2)
  })
})
