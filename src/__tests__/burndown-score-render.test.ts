import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeDefaults, parseCharter, parseSeat } from '../agents/burndown/policy.js'
import { renderScored, renderScoredRow, scoredPlan } from '../agents/burndown/score-render.js'
import { tasksFromList } from '../agents/burndown/score-source.js'
import type { DispatchRow } from '../agents/burndown/score.js'
import { withBroker } from '../cli/client.js'
import { burndownPlanVerb } from '../cli/verbs/burndown.js'

/** CC-230: `burndown plan --seat --scored` over the synthetic parity fixture; see its README. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const read = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')

interface Snapshot {
  today: string
  tasks: { id: string; slug: string }[]
}

interface Expected {
  order: { id: string; initiative: string; score: number; effective: number }[]
  initiatives: Record<string, number>
}

const snapshot = JSON.parse(read('tasks.json')) as Snapshot
const expected = JSON.parse(read('expected-sample-seat.json')) as Expected

function fixturePlan() {
  const charter = parseCharter(read('charter.md'))
  const seat = parseSeat(read('seats/sample-seat.md'), 'sample-seat')
  return scoredPlan({
    tasks: tasksFromList(snapshot),
    weights: expected.initiatives,
    defaults: mergeDefaults(charter, seat),
    exclusions: { tags: seat.excluded_tags, titlePatterns: seat.excluded_title_patterns },
    hardStops: charter.hard_stops,
    today: snapshot.today,
    top: 10,
  })
}

const ctx = { warnings: [], format: 'human' as const, withBroker }

describe('scored plan rendering of the parity fixture', () => {
  const lines = renderScored(fixturePlan())

  it('prints the top pick with rank, both scores, kind source and every component', () => {
    expect(lines[0]).toBe(
      ' 1  72.0 ( 72.0) AL-1      alpha            security/regex  ' +
        'S=1.00 P=1.00 U=0.00 A=1.00 W=1.00 K=1.00 R=1.00 Z=0.90 H=1.00 est=5 route=planner | ' +
        'Harden the secret store against injection',
    )
  })

  it("prints score.py's ten picks in its order with its effective and raw scores", () => {
    const columns = lines
      .slice(0, -1)
      .map(line => /^ *(\d+) +([\d.]+) \( *([\d.]+)\) (\S+) +(\S+) /.exec(line)?.slice(1))

    expect(columns).toEqual(
      expected.order.map((row, i) => [
        String(i + 1),
        row.effective.toFixed(1),
        row.score.toFixed(1),
        row.id,
        row.initiative,
      ]),
    )
  })

  it('ends with the scope, open count and refusal counts', () => {
    const open = snapshot.tasks.filter(t => (t as { status?: string }).status === 'open').length

    expect(lines).toHaveLength(11)
    expect(lines.at(-1)).toBe(
      `scope=5 initiatives, ${open} open, refused={excluded-tag: 4, excluded-pattern: 1}`,
    )
  })
})

describe('scored row flags', () => {
  const row = (): DispatchRow => {
    const [first] = fixturePlan().order
    if (first === undefined) throw new Error('fixture has no picks')
    return first
  }

  it('appends stop-short names and prints a missing estimate as a dash', () => {
    const line = renderScoredRow({ ...row(), estimate: null, stopShort: ['deploy', 'npm-publish'] }, 3)

    expect(line).toContain(' est=- route=planner stop-short:deploy,npm-publish | ')
    expect(line.startsWith(' 3 ')).toBe(true)
  })

  it('cuts a long title at 90 characters and a long initiative at 16', () => {
    const line = renderScoredRow({ ...row(), title: 'x'.repeat(120), initiative: 'i'.repeat(20) }, 1)

    expect(line.endsWith(` | ${'x'.repeat(90)}`)).toBe(true)
    expect(line).toContain(` ${'i'.repeat(16)} security/regex`)
  })

  it('lists share-cap skips after the exclusions and prints no refusals as {}', () => {
    const plan = { order: [], scope: 2, open: 0, refused: {} }

    expect(renderScored(plan)).toEqual(['scope=2 initiatives, 0 open, refused={}'])
    expect(renderScored({ ...plan, refused: { 'excluded-tag': 1, 'share-cap:nit': 2 } })).toEqual([
      'scope=2 initiatives, 0 open, refused={excluded-tag: 1, share-cap:nit: 2}',
    ])
  })
})

describe('burndown plan --seat --scored from disk', () => {
  const saved = { ...process.env }
  let world: string

  beforeEach(() => {
    world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-scored-')))
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = world
    for (const task of snapshot.tasks) {
      const dir = path.join(world, task.slug, 'tasks')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${task.id}.yml`), stringify(task))
    }
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(world, { recursive: true, force: true })
  })

  it("reads the seat's policy and task files and prints the fixture's plan", async () => {
    const args = { seat: 'sample-seat', scored: true, top: 10, autonomyRoot: FIXTURE, today: snapshot.today }

    const report = await burndownPlanVerb.run(args, ctx)

    expect(report).toEqual({ ok: true, lines: renderScored(fixturePlan()) })
  })

  it('refuses a seat the charter does not list', async () => {
    const args = { seat: 'no-such-seat', scored: true, autonomyRoot: FIXTURE }

    const report = await burndownPlanVerb.run(args, ctx)

    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([`no-such-seat is not a seat in ${FIXTURE}/charter.md`])
  })
})

describe('burndown plan flag refusals', () => {
  it.each([
    [{ scored: true }, 'burndown plan --scored needs --seat <name>'],
    [{ seat: 'sample-seat' }, 'burndown plan --seat needs --scored; the tick does not read seat scores yet'],
    [
      { seat: 'sample-seat', scored: false },
      'burndown plan --seat needs --scored; the tick does not read seat scores yet',
    ],
    [{ top: 5 }, 'burndown plan --top, --autonomy-root and --today apply only with --seat <name> --scored'],
    [
      { autonomyRoot: FIXTURE },
      'burndown plan --top, --autonomy-root and --today apply only with --seat <name> --scored',
    ],
    [
      { today: '2026-09-29' },
      'burndown plan --top, --autonomy-root and --today apply only with --seat <name> --scored',
    ],
  ])('refuses %o with a message', async (args, message) => {
    const report = await burndownPlanVerb.run(args, ctx)

    expect(report).toEqual({ ok: false, lines: [], errors: [message] })
  })
})
