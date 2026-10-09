import { describe, expect, it } from 'vitest'
import type { Task } from '../agents/burndown/eligibility.js'
import type { Runner } from '../agents/burndown/exec.js'
import { openPulls, originRepo } from '../agents/burndown/pr-adopt-ports.js'
import { adoptSeatPrs, type AdoptPorts, type AdoptSeat, type OpenPull } from '../agents/burndown/pr-adopt.js'
import {
  holdWithShepherd,
  registerWithShepherd,
  type Registration,
  type ShepherdRow,
  type ShepherdTarget,
} from '../agents/burndown/shepherd.js'

const NOW = new Date('2026-10-08T12:00:00Z')
const DAY_MS = 86_400_000

const seat: AdoptSeat = {
  seat: 'seat-a',
  prefix: 'sa',
  repos: [{ checkout: '/checkouts/widgets', initiatives: ['init'] }],
  staleDays: 7,
}

const pull = (over: Partial<OpenPull> = {}): OpenPull => ({
  number: 7,
  title: 'T-1: Add the widget',
  branch: 'agent-chat/sa-t-1-widget',
  updatedAt: NOW.toISOString(),
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'T-1',
  title: 'Add the widget',
  tags: ['kind:feature'],
  ...over,
})

const row = (pr: number): ShepherdRow => ({
  repo: 'acme/widgets',
  pr,
  runId: `run-${pr}`,
  phase: 'ci',
  headSha: null,
  stalled: null,
})

interface Fake {
  ports: AdoptPorts
  registered: Registration[]
  held: { target: ShepherdTarget; reason: string }[]
  seatLog: string[]
  events: string[]
  rows: ShepherdRow[] | undefined
}

function fake(opts: {
  pulls?: OpenPull[]
  tasks?: Task[]
  rows?: ShepherdRow[] | undefined
  size?: { additions: number; deletions: number }
  registerExit?: number
}): Fake {
  const f: Fake = {
    registered: [],
    held: [],
    seatLog: [],
    events: [],
    rows: 'rows' in opts ? opts.rows : [],
    ports: undefined as unknown as AdoptPorts,
  }
  f.ports = {
    repoOf: checkout => (checkout === '/checkouts/widgets' ? 'Acme/Widgets' : undefined),
    pulls: () => opts.pulls ?? [],
    diffSize: () => opts.size ?? { additions: 10, deletions: 5 },
    task: (initiatives, id) => {
      const found = (opts.tasks ?? []).find(t => t.id === id)
      return found === undefined ? undefined : { initiative: initiatives[0] as string, task: found }
    },
    shepherdRows: () => f.rows,
    register: reg => {
      if (opts.registerExit !== undefined)
        return { ok: false, refused: opts.registerExit === 65, reason: `exit ${opts.registerExit}` }
      f.registered.push(reg)
      f.rows = [...(f.rows ?? []), row(reg.target.pr)]
      return { ok: true }
    },
    hold: (target, reason) => {
      f.held.push({ target, reason })
      return true
    },
    logged: (_seat, key) => f.seatLog.some(line => line.includes(key)),
    append: (_seat, text) => void f.seatLog.push(text),
    log: event => void f.events.push(event),
  }
  return f
}

describe('the tick adopting a seat’s unregistered PRs (CC-861)', () => {
  it('registers a small unregistered seat PR with the task, implementer and kind, once', () => {
    const f = fake({ pulls: [pull()], tasks: [task()] })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)
    adoptSeatPrs([seat], new Set(), f.ports, NOW)

    expect(f.registered).toEqual([
      {
        target: { repo: 'Acme/Widgets', pr: 7 },
        task: 'init/T-1',
        implementer: 'sa-t-1-widget',
        kind: 'feature',
      },
    ])
    expect(f.held).toEqual([])
  })

  it('registers a PR over 400 changed lines and holds it as g10-review', () => {
    const f = fake({ pulls: [pull()], tasks: [task()], size: { additions: 380, deletions: 40 } })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)

    expect(f.registered).toHaveLength(1)
    expect(f.held).toEqual([
      {
        target: { repo: 'Acme/Widgets', pr: 7 },
        reason: 'g10-review: diff +380/-40 over 400 (size only); T-1',
      },
    ])
  })

  it('only flags a security-kind PR for the seat, once', () => {
    const f = fake({ pulls: [pull()], tasks: [task({ tags: ['kind:security'] })] })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)
    adoptSeatPrs([seat], new Set(), f.ports, NOW)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toHaveLength(1)
    expect(f.seatLog[0]).toMatch(/^burndown: Acme\/Widgets#7 .*g10-adversary/)
  })

  it('flags rather than registers a PR whose task it cannot find', () => {
    const f = fake({ pulls: [pull()], tasks: [] })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toHaveLength(1)
  })

  it('flags an authority change even when its kind is not security', () => {
    const f = fake({
      pulls: [pull({ title: 'T-1: Widen the permission profile' })],
      tasks: [task({ title: 'Widen the permission profile', tags: ['kind:agent-tooling'] })],
    })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toHaveLength(1)
  })

  it('logs when Shepherd is down and registers on the next tick', () => {
    const f = fake({ pulls: [pull()], tasks: [task()], rows: undefined })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)
    expect(f.registered).toEqual([])
    expect(f.events).toContain('burndown_pr_adopt_shepherd_down')

    f.rows = []
    adoptSeatPrs([seat], new Set(), f.ports, NOW)
    expect(f.registered).toHaveLength(1)
  })

  it('logs a register that serve did not answer and adds no seat line', () => {
    const f = fake({ pulls: [pull()], tasks: [task()], registerExit: 69 })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)

    expect(f.events).toContain('burndown_pr_adopt_register_failed')
    expect(f.seatLog).toEqual([])
  })

  it('gives a stale unregistered PR one flag line', () => {
    const idle = new Date(NOW.getTime() - 9 * DAY_MS).toISOString()
    const f = fake({ pulls: [pull({ updatedAt: idle })], tasks: [task({ tags: ['kind:security'] })] })

    adoptSeatPrs([seat], new Set(), f.ports, NOW)
    adoptSeatPrs([seat], new Set(), f.ports, NOW)

    const stale = f.seatLog.filter(l => l.includes('stale'))
    expect(stale).toEqual([
      'burndown: Acme/Widgets#7 stale: idle 9 days, over stale_pr_days 7 (sa-t-1-widget)',
    ])
  })

  it('leaves alone PRs of other prefixes, PRs Shepherd lists and PRs a claim holds', () => {
    const f = fake({
      pulls: [
        pull({ number: 1, branch: 'agent-chat/zz-t-1-other' }),
        pull({ number: 2 }),
        pull({ number: 3 }),
      ],
      tasks: [task()],
      rows: [row(2)],
    })

    adoptSeatPrs([seat], new Set(['acme/widgets#3']), f.ports, NOW)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toEqual([])
  })
})

describe('the tick’s real PR adoption ports (CC-861)', () => {
  it('reads open PRs from the REST list, one JSON object per line', () => {
    const exec: Runner = () => ({
      status: 0,
      stdout:
        '{"number":7,"title":"T-1: x","branch":"agent-chat/sa-t-1","updatedAt":"2026-10-01T00:00:00Z"}\nnot json\n',
    })

    expect(openPulls('Acme/Widgets', exec)).toEqual([
      { number: 7, title: 'T-1: x', branch: 'agent-chat/sa-t-1', updatedAt: '2026-10-01T00:00:00Z' },
    ])
  })

  it('names a checkout’s GitHub repo from its origin, ssh or https', () => {
    const at =
      (url: string): Runner =>
      () => ({ status: 0, stdout: `${url}\n` })

    expect(originRepo('/c', at('git@github.com:Acme/Widgets.git'))).toBe('Acme/Widgets')
    expect(originRepo('/c', at('https://github.com/Acme/Widgets'))).toBe('Acme/Widgets')
    expect(originRepo('/c', at('/srv/bare/widgets.git'))).toBeUndefined()
  })

  it('registers with --kind and holds with the reason, never --offline', () => {
    const calls: string[][] = []
    const exec: Runner = (_bin, args) => {
      calls.push(args)
      return args[1] === 'status' ? { status: 0, stdout: '[]' } : { status: 0, stdout: '' }
    }
    const target = { repo: 'Acme/Widgets', pr: 7 }

    registerWithShepherd({ target, task: 'init/T-1', implementer: 'sa-t-1', kind: 'feature' }, exec)
    holdWithShepherd(target, 'g10-review: big; T-1', exec)

    expect(calls.find(a => a[1] === 'register')).toEqual(expect.arrayContaining(['--kind', 'feature']))
    expect(calls.find(a => a[1] === 'hold')).toEqual(
      expect.arrayContaining(['Acme/Widgets#7', '--reason', 'g10-review: big; T-1']),
    )
    expect(calls.flat()).not.toContain('--offline')
  })
})
