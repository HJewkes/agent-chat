import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMilestoneFile } from '../agents/burndown/milestones.js'
import { mergeDefaults, parseCharter, parseSeat } from '../agents/burndown/policy.js'
import { isoWeek, renderScored, renderScoredRow, scoredPlan } from '../agents/burndown/score-render.js'
import { tasksFromList } from '../agents/burndown/score-source.js'
import type { PlannedRow } from '../agents/burndown/plan-order.js'
import { withBroker } from '../cli/client.js'
import { burndownPlanVerb, planFlagError } from '../cli/verbs/burndown.js'

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

function fixtureInputs(top = 10, shareCaps: Record<string, number> = {}) {
  const charter = parseCharter(read('charter.md'))
  const seat = parseSeat(read('seats/sample-seat.md'), 'sample-seat')
  const defaults = mergeDefaults(charter, seat)
  return {
    tasks: tasksFromList(snapshot),
    weights: expected.initiatives,
    defaults: { ...defaults, share_caps: { ...defaults.share_caps, ...shareCaps } },
    exclusions: { tags: seat.excluded_tags, titlePatterns: seat.excluded_title_patterns },
    hardStops: charter.hard_stops,
    today: snapshot.today,
    top,
  }
}

const fixturePlan = (top = 10, shareCaps: Record<string, number> = {}) =>
  scoredPlan(fixtureInputs(top, shareCaps))

const ctx = { warnings: [], format: 'human' as const, withBroker }

describe('scored plan rendering of the parity fixture', () => {
  const lines = renderScored(fixturePlan())

  it('prints the top pick with rank, both scores, kind source and every component', () => {
    expect(lines[0]).toBe(
      ' 1  72.0 ( 72.0) AL-1      alpha            security/regex  ' +
        'S=1.00 P=1.00 U=0.00 A=1.00 W=1.00 K=1.00 R=1.00 Z=0.90 H=1.00 est=5 route=planner tier=3 float=- wsjf=0.20 | ' +
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
      `scope=5 initiatives, ${open} open, skipped: 0, refused={excluded-tag: 4, excluded-pattern: 1}`,
    )
  })
})

describe('scored plan refusal counts', () => {
  it('adds share-cap skips from the dispatch order after the scoring exclusions', () => {
    const plan = fixturePlan(60, { product: 0.01 })

    expect(renderScored(plan).at(-1)).toBe(
      `scope=5 initiatives, ${plan.open} open, skipped: 0, refused={excluded-tag: 4, excluded-pattern: 1, share-cap:product: 6}`,
    )
  })
})

describe('scored row flags', () => {
  const row = (): PlannedRow => {
    const [first] = fixturePlan().order
    if (first === undefined) throw new Error('fixture has no picks')
    return first
  }

  it('appends stop-short names and prints a missing estimate as a dash', () => {
    const { wsjf: _unsized, ...unestimated } = row()
    const line = renderScoredRow({ ...unestimated, estimate: null, stopShort: ['deploy', 'npm-publish'] }, 3)

    expect(line).toContain(' est=- route=planner tier=3 float=- wsjf=- stop-short:deploy,npm-publish | ')
    expect(line.startsWith(' 3 ')).toBe(true)
  })

  it("prints a milestone row's tier, float and WSJF", () => {
    const line = renderScoredRow({ ...row(), tier: 2, float: 1.5, wsjf: 0.25, milestone: 'M1' }, 1)

    expect(line).toContain(' route=planner tier=2 float=1.5 wsjf=0.25 | ')
  })

  it('cuts a long title at 90 characters and a long initiative at 16', () => {
    const line = renderScoredRow({ ...row(), title: 'x'.repeat(120), initiative: 'i'.repeat(20) }, 1)

    expect(line.endsWith(` | ${'x'.repeat(90)}`)).toBe(true)
    expect(line).toContain(` ${'i'.repeat(16)} security/regex`)
  })

  it('lists share-cap skips after the exclusions and prints no refusals as {}', () => {
    const plan = { order: [], scope: 2, open: 0, refused: {}, skipped: [] }

    expect(renderScored(plan)).toEqual(['scope=2 initiatives, 0 open, skipped: 0, refused={}'])
    expect(renderScored({ ...plan, skipped: ['init-alpha/CC-2.yml'] })).toEqual([
      'scope=2 initiatives, 0 open, skipped: 1, refused={}',
    ])
    expect(renderScored({ ...plan, refused: { 'excluded-tag': 1, 'share-cap:nit': 2 } })).toEqual([
      'scope=2 initiatives, 0 open, skipped: 0, refused={excluded-tag: 1, share-cap:nit: 2}',
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

  it("orders by this week's milestone file in the autonomy root and prints its errors", async () => {
    const root = path.join(world, 'autonomy')
    fs.cpSync(FIXTURE, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'milestones'))
    const milestones = {
      week: '2026-W40',
      appetite_days: 5,
      milestones: [{ id: 'M1', rank: 1, seat: 'sample-seat', epics: ['AL-1', 'ZZ-404'] }],
    }
    fs.writeFileSync(path.join(root, 'milestones', '2026-W40.yml'), stringify(milestones))
    const last = snapshot.tasks.find(t => t.id === expected.order.at(-1)!.id)!
    const tagged = { ...last, tags: [...((last as { tags?: string[] }).tags ?? []), 'milestone:M1'] }
    fs.writeFileSync(path.join(world, last.slug, 'tasks', `${last.id}.yml`), stringify(tagged))
    const args = { seat: 'sample-seat', scored: true, top: 10, autonomyRoot: root, today: snapshot.today }

    const report = await burndownPlanVerb.run(args, ctx)

    expect(report.lines[0]).toMatch(new RegExp(`^ 1 .* ${last.id} .* tier=2 float=0\\.0 wsjf=`))
    expect(report.lines.at(-2)).toBe('milestones=2026-W40, errors: unknown-epic M1 ZZ-404')
  })

  it("does not report an epic as unknown when its task is on disk outside the seat's scope (CC-625)", async () => {
    const root = path.join(world, 'autonomy')
    fs.cpSync(FIXTURE, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'milestones'))
    const milestones = {
      week: '2026-W40',
      appetite_days: 5,
      milestones: [{ id: 'M1', rank: 1, seat: 'sample-seat', epics: ['XX-1', 'ZZ-404'] }],
    }
    fs.writeFileSync(path.join(root, 'milestones', '2026-W40.yml'), stringify(milestones))
    const archive = path.join(world, 'out-of-scope', 'tasks', 'archive')
    fs.mkdirSync(archive, { recursive: true })
    fs.writeFileSync(path.join(archive, 'XX-1.yml'), stringify({ id: 'XX-1', status: 'done' }))
    const args = { seat: 'sample-seat', scored: true, top: 10, autonomyRoot: root, today: snapshot.today }

    const report = await burndownPlanVerb.run(args, ctx)

    expect(report.lines.at(-2)).toBe('milestones=2026-W40, errors: unknown-epic M1 ZZ-404')
  })

  it("prints a typo'd dep: as an unknown-dep tag error, but not a dep on an archived task (CC-631)", async () => {
    const first = snapshot.tasks[0]!
    const archive = path.join(world, first.slug, 'tasks', 'archive')
    fs.mkdirSync(archive)
    fs.writeFileSync(path.join(archive, 'AR-1.yml'), stringify({ id: 'AR-1', status: 'closed' }))
    const tags = [...((first as { tags?: string[] }).tags ?? []), 'dep:AR-1', 'dep:ZZ-404']
    fs.writeFileSync(path.join(world, first.slug, 'tasks', `${first.id}.yml`), stringify({ ...first, tags }))
    const args = { seat: 'sample-seat', scored: true, top: 10, autonomyRoot: FIXTURE, today: snapshot.today }

    const report = await burndownPlanVerb.run(args, ctx)

    expect(report.lines.filter(line => line.startsWith('task tags'))).toEqual([
      `task tags errors: unknown-dep ${first.id} dep:ZZ-404`,
    ])
    expect(report.lines.at(-2)).toBe(`task tags errors: unknown-dep ${first.id} dep:ZZ-404`)
  })

  it('refuses a seat the charter does not list', async () => {
    const args = { seat: 'no-such-seat', scored: true, autonomyRoot: FIXTURE }

    const report = await burndownPlanVerb.run(args, ctx)

    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([`no-such-seat is not a seat in ${FIXTURE}/charter.md`])
  })
})

describe('the milestone file week', () => {
  it.each([
    ['2026-10-03', '2026-W40'],
    ['2026-10-05', '2026-W41'],
    ['2026-01-01', '2026-W01'],
    ['2024-12-30', '2025-W01'],
    ['2027-01-01', '2026-W53'],
  ])('%s falls in ISO week %s', (day, week) => {
    expect(isoWeek(day)).toBe(week)
  })
})

describe('burndown plan flag refusals', () => {
  it('accepts --seat without --scored, alone or with --autonomy-root', () => {
    expect(planFlagError({ seat: 'sample-seat' })).toBeUndefined()
    expect(planFlagError({ seat: 'sample-seat', autonomyRoot: FIXTURE })).toBeUndefined()
  })

  it.each([
    [{ scored: true }, 'burndown plan --scored needs --seat <name>'],
    [
      { seat: 'sample-seat', top: 5 },
      'burndown plan --top and --today apply only with --seat <name> --scored',
    ],
    [
      { seat: 'sample-seat', scored: false, today: '2026-09-29' },
      'burndown plan --top and --today apply only with --seat <name> --scored',
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

describe('unnamed criterion lines', () => {
  const task = (id: string, tags: string[]) => ({ ...tasksFromList(snapshot)[0]!, id, tags, estimate: 1 })
  const plan = (milestoneYaml: string) => {
    const tasks = [
      task('EX-1', ['milestone:M1', 'ms-role:criterion']),
      task('EX-2', ['milestone:M1', 'ms-role:criterion']),
    ]
    const milestones = parseMilestoneFile(milestoneYaml, ['EX-1', 'EX-2']).file
    return renderScored(
      scoredPlan({
        ...fixtureInputs(),
        tasks,
        weights: { ...fixtureInputs().weights },
        ...(milestones !== undefined && { milestones }),
      }),
    )
  }
  const yaml = `week: 2030-W01\nappetite_days: 5\nmilestones:\n  - id: M1\n    rank: 1\n    seat: s\n    done_when:\n      - kind: tasks-done\n        tasks: [EX-1]\n`

  it('prints exactly one line for the criterion task no check names', () => {
    expect(plan(yaml).filter(line => line.startsWith('unnamed-criterion'))).toEqual([
      'unnamed-criterion EX-2 milestone:M1',
    ])
  })
})

describe('held epic lines', () => {
  it('names each milestone epic held out of tier 2 with its reason', () => {
    const task = (id: string, estimate: number) => ({
      ...tasksFromList(snapshot)[0]!,
      id,
      tags: ['milestone:M1'],
      estimate,
    })
    const yaml = `week: 2030-W01\nappetite_days: 5\nmilestones:\n  - id: M1\n    rank: 1\n    seat: s\n    epics: [EP-1]\n`
    const milestones = parseMilestoneFile(yaml, ['EP-1']).file!

    const lines = renderScored(
      scoredPlan({ ...fixtureInputs(), tasks: [task('EP-1', 3), task('EP-2', 13)], seat: 's', milestones }),
    )

    expect(lines).toContain('epics held out of tier 2: EP-1 epic:M1; EP-2 epic-estimate:M1')
    expect(lines.at(-1)).toContain('epic:M1: 1, epic-estimate:M1: 1')
  })
})
