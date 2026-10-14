import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offPlanIdsOf } from '../agents/burndown/off-plan.js'
import { parseClassFile } from '../agents/burndown/plan-class.js'
import { classifyFromDisk, renderClassify } from '../cli/verbs/burndown-classify.js'

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

const run = (write: boolean) =>
  classifyFromDisk({ planPath, initiatives: ['titan-platform'], root, outDir, write, now: NOW })

describe('burndown classify (TP-2418 b)', () => {
  it('classifies every open task, untagged ones too, and writes the dated v1 file', () => {
    const result = run(true)

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

  it('writes nothing on a dry run', () => {
    const result = run(false)

    expect(result.rows).toHaveLength(3)
    expect(renderClassify(result).at(-1)).toBe('dry run: nothing written (pass --write)')
    expect(fs.existsSync(outDir)).toBe(false)
  })

  it('refuses a plan without section 2 and writes no file', () => {
    fs.writeFileSync(planPath, '# Factory plan\n\n## 3. Later\n')

    expect(() => run(true)).toThrow(/no "## 2\." section/)
    expect(fs.existsSync(outDir)).toBe(false)
  })

  it('leaves closed tasks out', () => {
    task('TP-13', { status: 'done' })

    expect(run(false).rows.map(row => row.id)).toEqual(['TP-10', 'TP-11', 'TP-12'])
  })

  it('overwrites the same day file on a second run', () => {
    run(true)
    task('TP-14', {})

    run(true)

    const text = fs.readFileSync(path.join(outDir, 'off-plan-2026-10-14.md'), 'utf8')
    expect(parseClassFile(text)?.map(row => row.id)).toEqual(['TP-10', 'TP-11', 'TP-12', 'TP-14'])
  })
})
