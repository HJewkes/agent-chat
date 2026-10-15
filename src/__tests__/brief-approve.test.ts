import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approveBrief,
  approvePortsOn,
  autoApprovePortsOn,
  briefVersion,
  finishBriefRoutes,
  recordBriefRoutes,
  settleProposedBriefs,
} from '../agents/burndown/brief-approve.js'
import { briefReviewSection, deciderVerdict } from '../agents/burndown/decider.js'
import { opsNoneTag } from '../agents/burndown/ops.js'
import { renderClassFile, type PlanClass } from '../agents/burndown/plan-class.js'
import type { AgentIdentity } from '../protocol.js'

const TASK = `id: CC-1
title: "t"
tags:
  - kind:x
  - brief:proposed=2026-10-09
`

describe('burndown brief approve', () => {
  let root: string
  let edits: string[][]
  const ports = () => ({
    ...approvePortsOn(root),
    edit: (_slug: string, _id: string, args: string[]) => void edits.push(args),
  })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-approve-'))
    fs.mkdirSync(path.join(root, 'init', 'tasks'), { recursive: true })
    fs.mkdirSync(path.join(root, 'init', 'sources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'init', 'tasks', 'CC-1.yml'), TASK)
    edits = []
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('rewrites the proposed tag to brief:ready=<today> through task edit', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    const report = approveBrief('CC-1', ports(), '2026-10-10')
    expect(report.ok).toBe(true)
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--add-tag', 'brief:src=briefer'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('replaces a seat brief:src so the task carries one src, briefer', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:src=seat\n  - brief:proposed=2026-10-09\n',
    )
    approveBrief('CC-1', ports(), '2026-10-10')
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--add-tag', 'brief:src=briefer'],
      ['--remove-tag', 'brief:src=seat'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('does not re-add brief:src=briefer when it is already the only src', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:src=briefer\n  - brief:proposed=2026-10-09\n',
    )
    approveBrief('CC-1', ports(), '2026-10-10')
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('leaves a ready seat brief with no proposal, and its src, untouched', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:ready=2026-10-01\n  - brief:src=seat\n',
    )
    expect(approveBrief('CC-1', ports(), '2026-10-10').ok).toBe(false)
    expect(edits).toEqual([])
  })

  it('removes an older brief:ready so only the new day remains', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:ready=2026-09-01\n  - brief:proposed=2026-10-09\n',
    )
    approveBrief('CC-1', ports(), '2026-10-10')
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--add-tag', 'brief:src=briefer'],
      ['--remove-tag', 'brief:ready=2026-09-01'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('lifts a seat hold when the brief is approved by hand', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:proposed=2026-10-09\n  - brief:held=owner-call\n',
    )

    const report = approveBrief('CC-1', ports(), '2026-10-10')

    expect(report.ok).toBe(true)
    expect(edits).toContainEqual(['--remove-tag', 'brief:held=owner-call'])
  })

  it('refuses an unknown task', () => {
    const report = approveBrief('CC-9', ports(), '2026-10-10')
    expect(report.errors?.[0]).toContain('no task CC-9')
  })

  it('refuses when no plan file exists', () => {
    const report = approveBrief('CC-1', ports(), '2026-10-10')
    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('no plan file')
    expect(edits).toEqual([])
  })

  it('refuses a task with no proposal', () => {
    fs.writeFileSync(path.join(root, 'init', 'tasks', 'CC-1.yml'), 'id: CC-1\ntags:\n  - kind:x\n')
    expect(approveBrief('CC-1', ports(), '2026-10-10').ok).toBe(false)
  })

  describe('off-plan gate (TP-2418)', () => {
    const classFile = (cls: PlanClass) => {
      const dir = path.join(root, 'claude-channels', 'sources', 'factory-review')
      fs.mkdirSync(dir, { recursive: true })
      const row = { class: cls, id: 'CC-1', initiative: 'init', detail: 'P3', ask: '-' }
      fs.writeFileSync(path.join(dir, 'off-plan-2026-10-13.md'), renderClassFile('classes', [row]))
      fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    }

    it.each<PlanClass>(['off', 'ambiguous'])(
      'refuses a proposed task the newest file lists %s, and edits nothing',
      cls => {
        classFile(cls)

        const report = approveBrief('CC-1', ports(), '2026-10-10')

        expect(report.ok).toBe(false)
        expect(report.errors?.[0]).toContain('CC-1 is off plan')
        expect(report.errors?.[0]).toContain('--off-plan-ok')
        expect(edits).toEqual([])
      },
    )

    it('refuses a task whose triage note puts it outside the plan', () => {
      fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
      fs.writeFileSync(
        path.join(root, 'init', 'tasks', 'CC-1.yml'),
        `${TASK}notes: "Outside accepted factory plan p-list."\n`,
      )

      const report = approveBrief('CC-1', ports(), '2026-10-10')

      expect(report.errors?.[0]).toContain('triage note')
      expect(edits).toEqual([])
    })

    it('approves an off-plan task given --off-plan-ok and logs the reason as a note', () => {
      classFile('off')

      const report = approveBrief('CC-1', ports(), '2026-10-10', 'owner ordered 2026-10-12')

      expect(report.ok).toBe(true)
      expect(edits).toContainEqual(['--add-tag', 'brief:ready=2026-10-10'])
      expect(edits.at(-1)).toEqual(['--append', '2026-10-10: approved off plan: owner ordered 2026-10-12'])
    })

    it('refuses a blank --off-plan-ok reason', () => {
      classFile('off')

      expect(approveBrief('CC-1', ports(), '2026-10-10', '  ').ok).toBe(false)
      expect(edits).toEqual([])
    })

    it('approves an on-plan task as before, with no note', () => {
      classFile('on')

      const report = approveBrief('CC-1', ports(), '2026-10-10')

      expect(report.ok).toBe(true)
      expect(edits).toEqual([
        ['--add-tag', 'brief:ready=2026-10-10'],
        ['--add-tag', 'brief:src=briefer'],
        ['--remove-tag', 'brief:proposed=2026-10-09'],
      ])
    })
  })

  describe('ops tag on promotion (CC-1154)', () => {
    const RULESET = 'the tick no longer refuses; update the ruleset docs page'
    const withDoneWhen = (doneWhen: string, extraTags: string[] = []) => {
      fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
      const tags = ['brief:proposed=2026-10-09', ...extraTags].map(t => `  - ${t}\n`).join('')
      fs.writeFileSync(
        path.join(root, 'init', 'tasks', 'CC-1.yml'),
        `id: CC-1\ndone_when: "${doneWhen}"\ntags:\n${tags}`,
      )
    }

    it('adds ops:none for the done_when when it mentions no op', () => {
      withDoneWhen('unit tests cover it')

      const report = approveBrief('CC-1', ports(), '2026-10-10')

      expect(report.ok).toBe(true)
      expect(edits[0]).toEqual(['--add-tag', opsNoneTag('unit tests cover it')])
      expect(edits).toContainEqual(['--add-tag', 'brief:ready=2026-10-10'])
    })

    it('hashes a folded multi-line done_when as the tick reads it', () => {
      fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
      fs.writeFileSync(
        path.join(root, 'init', 'tasks', 'CC-1.yml'),
        'id: CC-1\ndone_when: "unit tests\n  cover it"\ntags:\n  - brief:proposed=2026-10-09\n',
      )

      approveBrief('CC-1', ports(), '2026-10-10')

      expect(edits[0]).toEqual(['--add-tag', opsNoneTag('unit tests cover it')])
    })

    it('refuses an untagged ruleset done_when, naming the op and the exact tag, and edits nothing', () => {
      withDoneWhen(RULESET)

      const report = approveBrief('CC-1', ports(), '2026-10-10')

      expect(report.ok).toBe(false)
      expect(report.errors?.[0]).toContain('ruleset-write')
      expect(report.errors?.[0]).toContain(opsNoneTag(RULESET))
      expect(edits).toEqual([])
    })

    it.each([
      ['a declared op', 'ops:ruleset-write'],
      ['the matching ops:none tag', opsNoneTag(RULESET)],
    ])('promotes a ruleset done_when carrying %s with no second ops tag', (_scenario, tag) => {
      withDoneWhen(RULESET, [tag])

      const report = approveBrief('CC-1', ports(), '2026-10-10')

      expect(report.ok).toBe(true)
      expect(edits.filter(([, t]) => t?.startsWith('ops:'))).toEqual([])
    })
  })
})

describe('the tick auto-approves a proposed brief (CC-1234)', () => {
  const TODAY = '2026-10-13'
  const PROPOSED = `brief:proposed=${TODAY}`
  const slice = { n: 'a', title: 'one slice', points: 2, doneWhen: 'tests pass', owns: ['src/a.ts'] }
  const planWith = (slices: unknown[]): string =>
    `# Plan\n\n\`\`\`burndown-slices\n${JSON.stringify(slices)}\n\`\`\`\n`
  const LINTED = planWith([slice])
  const UNLINTED = planWith([{ ...slice, points: 8 }])
  const SENT = `brief:decider=${briefVersion(PROPOSED, UNLINTED)}`

  let root: string
  let edits: string[][]

  const writeTask = (tags: string[], status = 'open'): void => {
    const list = tags.map(t => `  - ${t}\n`).join('')
    fs.writeFileSync(
      path.join(root, 'demo', 'tasks', 'T-1.yml'),
      `id: T-1\ntitle: "synthetic"\nstatus: ${status}\ndone_when: "unit tests cover it"\ntags:\n${list}`,
    )
  }
  const writePlan = (text: string): void =>
    fs.writeFileSync(path.join(root, 'demo', 'sources', 'T-1-plan.md'), text)
  const ports = () => ({
    ...autoApprovePortsOn(root),
    edit: (_slug: string, _id: string, args: string[]) => void edits.push(args),
  })
  const settle = ({ dryRun = false, decider = true } = {}) =>
    settleProposedBriefs(ports(), { today: TODAY, dryRun, decider })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-auto-'))
    fs.mkdirSync(path.join(root, 'demo', 'tasks'), { recursive: true })
    fs.mkdirSync(path.join(root, 'demo', 'sources'), { recursive: true })
    edits = []
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('approves a lint-passing brief on the tick it was proposed, with an audit note', () => {
    writeTask(['kind:x', PROPOSED])
    writePlan(LINTED)

    const settled = settle()

    expect(edits).toContainEqual(['--add-tag', `brief:ready=${TODAY}`])
    expect(edits).toContainEqual(['--remove-tag', PROPOSED])
    expect(edits.at(-1)?.[0]).toBe('--append')
    expect(edits.at(-1)?.[1]).toContain('auto-approved')
    expect(settled.lines.join('\n')).toContain('auto: slice lint passed')
    expect(settled.routes).toEqual([])
    expect(settled.approved).toEqual([{ slug: 'demo', taskId: 'T-1' }])
  })

  it('routes a lint-failing brief to the decider without recording a send while settling', () => {
    writeTask([PROPOSED])
    writePlan(UNLINTED)

    const { routes, approved } = settle()

    expect(edits).toEqual([])
    expect(approved).toEqual([])
    expect(routes).toHaveLength(1)
    expect(routes[0]?.tag).toBe(SENT)
    expect(routes[0]?.section).toContain('over the 3-point limit')
  })

  it('does not route the same brief version a second time', () => {
    writeTask([PROPOSED, SENT])
    writePlan(UNLINTED)

    const settled = settle()

    expect(settled.routes).toEqual([])
    expect(edits).toEqual([])
    expect(settled.lines.join('\n')).toContain('already with the decider')
  })

  it('routes a rewritten plan again and drops the old version record once sent', () => {
    const old = `brief:decider=${briefVersion(PROPOSED, 'an older plan')}`
    writeTask([PROPOSED, old])
    writePlan(UNLINTED)

    const { recorded } = recordBriefRoutes(settle().routes, ports())
    finishBriefRoutes(recorded, { sent: true }, ports())

    expect(recorded).toHaveLength(1)
    expect(edits).toEqual([
      ['--add-tag', SENT],
      ['--remove-tag', old],
    ])
  })

  it('unrecords a route whose decider wake did not go out, so the next tick retries it', () => {
    writeTask([PROPOSED])
    writePlan(UNLINTED)

    const { recorded } = recordBriefRoutes(settle().routes, ports())
    const lines = finishBriefRoutes(recorded, { sent: false, reason: 'decider is live' }, ports())

    expect(edits).toEqual([
      ['--add-tag', SENT],
      ['--remove-tag', SENT],
    ])
    expect(lines.join('\n')).toContain('retried next tick')
  })

  it('does not send a route whose record could not be written', () => {
    writeTask([PROPOSED])
    writePlan(UNLINTED)
    const failing = {
      edit: () => {
        throw new Error('synthetic edit failure')
      },
    }

    const { recorded, lines } = recordBriefRoutes(settle().routes, failing)

    expect(recorded).toEqual([])
    expect(lines.join('\n')).toContain('could not record the send')
  })

  it('un-writes a record whose add exited non-zero, so the next tick routes it again', () => {
    writeTask([PROPOSED])
    writePlan(UNLINTED)
    const addFails = {
      edit: (_slug: string, _id: string, args: string[]) => {
        edits.push(args)
        if (args[0] === '--add-tag') throw new Error('synthetic exit after write')
      },
    }

    const { recorded, lines } = recordBriefRoutes(settle().routes, addFails)

    expect(edits).toEqual([
      ['--add-tag', SENT],
      ['--remove-tag', SENT],
    ])
    expect(recorded).toEqual([])
    expect(lines.join('\n')).toContain('retried next tick')
  })

  it('keeps the record when the wake went out unanswered, since it may have landed', () => {
    writeTask([PROPOSED])
    writePlan(UNLINTED)

    const { recorded } = recordBriefRoutes(settle().routes, ports())
    finishBriefRoutes(recorded, { sent: false, reason: 'broker did not answer', unknown: true }, ports())

    expect(edits).toEqual([['--add-tag', SENT]])
  })

  it.each([
    ['a plan with no slices block', '# Plan\n\nprose only\n'],
    ['a slices block that is not JSON', '# Plan\n\n```burndown-slices\n{nope\n```\n'],
  ])('never approves %s and routes it to the decider', (_scenario, plan) => {
    writeTask([PROPOSED])
    writePlan(plan)

    const { routes } = settle()

    expect(edits.some(([flag, tag]) => flag === '--add-tag' && tag?.startsWith('brief:ready'))).toBe(false)
    expect(routes).toHaveLength(1)
  })

  it('routes a lint-passing brief whose done_when has an unresolved op to the decider', () => {
    fs.writeFileSync(
      path.join(root, 'demo', 'tasks', 'T-1.yml'),
      `id: T-1\nstatus: open\ndone_when: "update the ruleset docs page"\ntags:\n  - ${PROPOSED}\n`,
    )
    writePlan(LINTED)

    const { routes } = settle()

    expect(edits.some(([, tag]) => tag?.startsWith('brief:ready'))).toBe(false)
    expect(routes[0]?.section).toContain('ruleset-write')
  })

  it.each([
    ['needs-human', 'tagged needs-human'],
    ['human-only', 'tagged human-only'],
    ['brief:needs-human', 'tagged brief:needs-human'],
    ['blocked', 'tagged blocked'],
    ['needs-decision', 'tagged needs-decision'],
    ['brief:held', 'tagged brief:held'],
    ['brief:held=waits-on-CC-1328', 'held by the seat: waits-on-CC-1328'],
  ])('never approves or routes a task tagged %s', (flag, reason) => {
    writeTask([PROPOSED, flag])
    writePlan(LINTED)

    const settled = settle()

    expect(edits).toEqual([])
    expect(settled.routes).toEqual([])
    expect(settled.lines.join('\n')).toContain(reason)
  })

  it('a seat-held brief stays proposed through a tick and is approved once the hold is lifted', () => {
    writeTask([PROPOSED, 'brief:held=owner-call'])
    writePlan(LINTED)

    const held = settle()

    expect(edits).toEqual([])
    expect(held.approved).toEqual([])
    expect(held.routes).toEqual([])
    expect(fs.readFileSync(path.join(root, 'demo', 'tasks', 'T-1.yml'), 'utf8')).toContain(PROPOSED)

    writeTask([PROPOSED])
    const released = settle()

    expect(edits).toContainEqual(['--add-tag', `brief:ready=${TODAY}`])
    expect(released.approved).toEqual([{ slug: 'demo', taskId: 'T-1' }])
  })

  it('never approves a plan flagged needs-human', () => {
    writeTask([PROPOSED])
    writePlan(`needs-human: the owner picks the schema\n\n${LINTED}`)

    const settled = settle()

    expect(edits).toEqual([])
    expect(settled.lines.join('\n')).toContain('plan is flagged needs-human')
  })

  it('never approves or routes a brief whose plan file is missing', () => {
    writeTask([PROPOSED])

    const settled = settle()

    expect(edits).toEqual([])
    expect(settled.routes).toEqual([])
    expect(settled.lines.join('\n')).toContain('no readable plan file')
  })

  it('leaves a closed task with a stale proposal alone, silently', () => {
    writeTask([PROPOSED], 'done')
    writePlan(LINTED)

    expect(settle()).toEqual({ lines: [], routes: [], approved: [] })
    expect(edits).toEqual([])
  })

  it('leaves a failing brief for the seat when no decider is configured', () => {
    writeTask([PROPOSED])
    writePlan(UNLINTED)

    const settled = settle({ decider: false })

    expect(edits).toEqual([])
    expect(settled.routes).toEqual([])
    expect(settled.lines.join('\n')).toContain('no decider configured')
  })

  it('edits nothing on a dry run, approving or routing', () => {
    writeTask([PROPOSED])
    writePlan(LINTED)
    const approving = settle({ dryRun: true })
    writePlan(UNLINTED)

    const routing = settle({ dryRun: true })

    expect(edits).toEqual([])
    expect(approving.lines).toEqual(['would approve brief T-1: slice lint passed'])
    expect(routing.routes).toHaveLength(1)
  })
})

describe('failing briefs share the decider gate (CC-1234)', () => {
  const NOW = new Date('2026-10-13T12:00:00Z')
  const row = (state: AgentIdentity['state']): AgentIdentity =>
    ({ agentId: 'agent-1', name: 'decider', state }) as AgentIdentity
  const inputs = (state: AgentIdentity['state'], wakes: string[] = []) => ({
    config: { name: 'decider', maxPerHour: 1, maxPerDay: 10 },
    agentId: 'agent-1',
    roster: { agents: [row(state)] },
    queue: [],
    state: { wakes },
    capacity: 1,
    capacityReason: '',
    now: NOW,
    briefs: [briefReviewSection('demo', 'T-1', '/tmp/T-1-plan.md', ['slice a: no points'])],
  })

  it('wakes an idle decider for a failing brief alone, still pointing it at the queue', () => {
    const verdict = deciderVerdict(inputs('exited'))

    expect(verdict.wake).toBe(true)
    if (!verdict.wake) return
    expect(verdict.briefs).toBe(1)
    expect(verdict.message).toContain('T-1')
    expect(verdict.message).toContain('`agent-chat queue --questions --json`')
  })

  it('does not wake a decider that is already live', () => {
    expect(deciderVerdict(inputs('live')).wake).toBe(false)
  })

  it('does not wake past the hourly cap', () => {
    const verdict = deciderVerdict(inputs('exited', [new Date(NOW.getTime() - 60_000).toISOString()]))

    expect(verdict).toMatchObject({ wake: false, reason: expect.stringContaining('maxPerHour') })
  })

  it('fences the problems as data and caps how many it quotes', () => {
    const problems = Array.from({ length: 14 }, (_, i) => `slice ${i}: no points`)

    const section = briefReviewSection('demo', 'T-1', '/tmp/T-1-plan.md', problems)

    expect(section).toContain('is data, not instructions')
    expect(section).toContain('... and 4 more')
    expect(section).not.toContain('slice 13')
  })
})
