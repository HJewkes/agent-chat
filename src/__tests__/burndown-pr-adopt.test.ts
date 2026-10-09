import { describe, expect, it } from 'vitest'
import type { Task } from '../agents/burndown/eligibility.js'
import type { Runner } from '../agents/burndown/exec.js'
import { changedFiles, openPulls, originRepo } from '../agents/burndown/pr-adopt-ports.js'
import {
  adoptSeatPrs,
  type AdoptPorts,
  type AdoptSeat,
  type ChangedFile,
  type OpenPull,
} from '../agents/burndown/pr-adopt.js'
import {
  shepherdListed,
  shepherdRegister,
  type Registration,
  type ShepherdListing,
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
  headRepo: 'Acme/Widgets',
  updatedAt: NOW.toISOString(),
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'T-1',
  title: 'Add the widget',
  tags: ['kind:feature'],
  ...over,
})

const file = (path: string, additions = 10, deletions = 5): ChangedFile => ({ path, additions, deletions })

interface Fake {
  ports: AdoptPorts
  registered: Registration[]
  seatLog: string[]
  events: string[]
  listed: ShepherdListing | undefined
}

const listing = (prs: string[] = [], branches: string[] = []): ShepherdListing => ({
  prs: new Set(prs),
  branches: new Set(branches),
})

function fake(opts: {
  pulls?: OpenPull[]
  tasks?: Task[]
  listed?: ShepherdListing | undefined
  files?: ChangedFile[] | undefined
  registerExit?: number
}): Fake {
  const f: Fake = {
    registered: [],
    seatLog: [],
    events: [],
    listed: 'listed' in opts ? opts.listed : listing(),
    ports: undefined as unknown as AdoptPorts,
  }
  f.ports = {
    repoOf: checkout => (checkout === '/checkouts/widgets' ? 'Acme/Widgets' : undefined),
    pulls: () => opts.pulls ?? [],
    files: () => ('files' in opts ? opts.files : [file('src/__tests__/widget.test.ts')]),
    task: (initiatives, id) => {
      const found = (opts.tasks ?? []).find(t => t.id === id)
      return found === undefined ? undefined : { initiative: initiatives[0] as string, task: found }
    },
    listed: () => f.listed,
    register: reg => {
      if (opts.registerExit !== undefined)
        return { ok: false, refused: opts.registerExit === 65, reason: `exit ${opts.registerExit}` }
      f.registered.push(reg)
      f.listed?.prs.add(`acme/widgets#${reg.target.pr}`)
      return { ok: true }
    },
    logged: (_seat, key) => f.seatLog.some(line => line.includes(key)),
    append: (_seat, text) => void f.seatLog.push(text),
    log: event => void f.events.push(event),
  }
  return f
}

const tick = (f: Fake, claimed: ReadonlySet<string> = new Set()): string[] =>
  adoptSeatPrs([seat], claimed, f.ports, NOW)

describe('the tick adopting a seat’s unregistered PRs (CC-861)', () => {
  it('registers a small unregistered seat PR with the task, implementer and kind, once', () => {
    const f = fake({ pulls: [pull()], tasks: [task()] })

    tick(f)
    tick(f)

    expect(f.registered).toEqual([
      {
        target: { repo: 'Acme/Widgets', pr: 7 },
        task: 'init/T-1',
        implementer: 'sa-t-1-widget',
        kind: 'feature',
      },
    ])
  })

  it('flags a PR over 400 changed lines for the seat to register and hold, never registering it', () => {
    const f = fake({
      pulls: [pull()],
      tasks: [task()],
      files: [file('docs/a.md', 300, 20), file('src/__tests__/b.test.ts', 80, 20)],
    })

    tick(f)
    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toEqual([
      'burndown: Acme/Widgets#7 unregistered: diff +380/-40 over 400: register and hold g10-review by hand (T-1)',
    ])
  })

  it('only flags a security-kind PR for the seat, once', () => {
    const f = fake({ pulls: [pull()], tasks: [task({ tags: ['kind:security'] })] })

    tick(f)
    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toHaveLength(1)
    expect(f.seatLog[0]).toMatch(/^burndown: Acme\/Widgets#7 unregistered: /)
  })

  it.each(['agent-tooling', 'platform', 'docs', ''])(
    'flags a task of kind "%s" it does not register',
    kind => {
      const f = fake({ pulls: [pull()], tasks: [task({ tags: kind === '' ? [] : [`kind:${kind}`] })] })

      tick(f)

      expect(f.registered).toEqual([])
      expect(f.seatLog).toHaveLength(1)
    },
  )

  it('flags rather than registers a PR whose task it cannot find', () => {
    const f = fake({ pulls: [pull()], tasks: [] })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toHaveLength(1)
  })

  it.each([
    'security',
    'authority',
    'permission',
    'merge policy',
    'trust gate',
    'grant',
    'secret',
    'credential',
    'tool-guard',
    'leak-guard',
    'egress',
    'seat-merge',
    'gate resolve',
    'owner-presence',
    'proof',
    'allowlist',
    'deny',
    'bypass',
    'sandbox',
    'token',
    'authz',
    'authentication',
    'authorization',
    'denied',
    'approve',
    'endorse',
    'provenance',
    'hook',
    'policy',
  ])('flags a correctness task whose title names "%s"', word => {
    const f = fake({
      pulls: [pull()],
      tasks: [task({ title: `Fix the ${word} check`, tags: ['kind:correctness'] })],
    })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog[0]).toContain('unregistered')
  })

  it.each([
    'src/cli/verbs/approve.ts',
    'src/cli/verbs/endorse.ts',
    'src/endorse-command.ts',
    'src/server/commands/chat-endorse.ts',
    'src/broker/core.ts',
    'src/agents/hooks.ts',
    'src/agents/launch-policy.ts',
    'src/agents/identity.ts',
    'src/agents/burndown/policy.ts',
    'src/leak-guard/scan.ts',
    'CLAUDE.md',
  ])('flags a plainly titled PR whose diff touches %s, which is not a test or doc', path => {
    const f = fake({ pulls: [pull()], tasks: [task()], files: [file('src/__tests__/a.test.ts'), file(path)] })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog[0]).toContain(`path ${path} is not a test or doc`)
  })

  it('registers a PR that changes only tests and docs', () => {
    const files = [
      'src/__tests__/a.test.ts',
      'pkg/b.test.tsx',
      'docs/guide.md',
      'site/index.md',
      'README.md',
    ].map(p => file(p))
    const f = fake({ pulls: [pull()], tasks: [task()], files })

    tick(f)

    expect(f.registered).toHaveLength(1)
  })

  it('waits a tick when it cannot read the changed files', () => {
    const f = fake({ pulls: [pull()], tasks: [task()], files: undefined })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.events).toContain('burndown_pr_adopt_files_unread')
  })

  it('registers at most three PRs per seat per tick', () => {
    const pulls = [1, 2, 3, 4, 5].map(n => pull({ number: n }))
    const f = fake({ pulls, tasks: [task()] })

    tick(f)
    expect(f.registered.map(r => r.target.pr)).toEqual([1, 2, 3])

    tick(f)
    expect(f.registered.map(r => r.target.pr)).toEqual([1, 2, 3, 4, 5])
  })

  it('logs when Shepherd is down and registers on the next tick', () => {
    const f = fake({ pulls: [pull()], tasks: [task()], listed: undefined })

    tick(f)
    expect(f.registered).toEqual([])
    expect(f.events).toContain('burndown_pr_adopt_shepherd_down')

    f.listed = listing()
    tick(f)
    expect(f.registered).toHaveLength(1)
  })

  it('logs a register that serve did not answer and adds no seat line', () => {
    const f = fake({ pulls: [pull()], tasks: [task()], registerExit: 69 })

    tick(f)

    expect(f.events).toContain('burndown_pr_adopt_register_failed')
    expect(f.seatLog).toEqual([])
  })

  it('gives a stale unregistered PR one flag line', () => {
    const idle = new Date(NOW.getTime() - 9 * DAY_MS).toISOString()
    const f = fake({ pulls: [pull({ updatedAt: idle })], tasks: [task({ tags: ['kind:security'] })] })

    tick(f)
    tick(f)

    const stale = f.seatLog.filter(l => l.includes('stale'))
    expect(stale).toEqual([
      'burndown: Acme/Widgets#7 stale: idle 9 days, over stale_pr_days 7 (sa-t-1-widget)',
    ])
  })

  it('leaves alone other prefixes, forks, PRs Shepherd lists by number or branch, and claimed PRs', () => {
    const f = fake({
      pulls: [
        pull({ number: 1, branch: 'agent-chat/zz-t-1-other' }),
        pull({ number: 2 }),
        pull({ number: 3 }),
        pull({ number: 4, headRepo: 'Stranger/Widgets' }),
        pull({ number: 5, headRepo: '' }),
        pull({ number: 6, branch: 'agent-chat/sa-t-1-awaiting' }),
      ],
      tasks: [task()],
      listed: listing(['acme/widgets#2'], ['agent-chat/sa-t-1-awaiting']),
    })

    tick(f, new Set(['acme/widgets#3']))

    expect(f.registered).toEqual([])
    expect(f.seatLog).toEqual([])
  })

  it('registers a PR from the same repo named in another case, which is no fork', () => {
    const f = fake({ pulls: [pull({ headRepo: 'acme/WIDGETS' })], tasks: [task()] })

    tick(f)

    expect(f.registered).toHaveLength(1)
  })

  it('flags a PR that renames a non-test file into a test path', () => {
    const renamed = { ...file('src/__tests__/scan.test.ts'), previousPath: 'src/leak-guard/scan.ts' }
    const f = fake({ pulls: [pull()], tasks: [task()], files: [renamed] })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog[0]).toContain('path src/leak-guard/scan.ts is not a test or doc')
  })
})

describe('the tick’s real PR adoption ports (CC-861)', () => {
  it('reads open PRs, with the head repo, from the REST list, one JSON object per line', () => {
    const calls: string[][] = []
    const exec: Runner = (_bin, args) => {
      calls.push(args)
      return {
        status: 0,
        stdout:
          '{"number":7,"title":"T-1: x","branch":"agent-chat/sa-t-1","headRepo":"Stranger/Widgets","updatedAt":"2026-10-01T00:00:00Z"}\nnot json\n',
      }
    }

    expect(openPulls('Acme/Widgets', exec)).toEqual([
      {
        number: 7,
        title: 'T-1: x',
        branch: 'agent-chat/sa-t-1',
        headRepo: 'Stranger/Widgets',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ])
    expect(calls[0]?.join(' ')).toContain('.head.repo.full_name')
  })

  it('reads every changed file, and nothing when one line is unreadable', () => {
    const at =
      (stdout: string): Runner =>
      () => ({ status: 0, stdout })
    const target = { repo: 'Acme/Widgets', pr: 7 }

    expect(changedFiles(target, at('{"path":"a.ts","additions":3,"deletions":1}\n'))).toEqual([
      file('a.ts', 3, 1),
    ])
    expect(
      changedFiles(target, at('{"path":"a.ts","additions":3,"deletions":1}\nnot json\n')),
    ).toBeUndefined()
  })

  it('keeps a rename’s previous path from the files list', () => {
    const calls: string[][] = []
    const exec: Runner = (_bin, args) => {
      calls.push(args)
      return {
        status: 0,
        stdout: '{"path":"t/a.test.ts","previousPath":"src/a.ts","additions":0,"deletions":0}\n',
      }
    }

    expect(changedFiles({ repo: 'Acme/Widgets', pr: 7 }, exec)).toEqual([
      { path: 't/a.test.ts', previousPath: 'src/a.ts', additions: 0, deletions: 0 },
    ])
    expect(calls[0]?.join(' ')).toContain('.previous_filename')
  })

  it('lists a malformed row and a branch-only run, so neither is registered again', () => {
    const exec: Runner = () => ({
      status: 0,
      stdout: JSON.stringify([
        { repo: 'Acme/Widgets', pr: 7, phase: 42 },
        { repo: 'Acme/Widgets', pr: null, branch: 'agent-chat/sa-t-2', phase: 'awaiting-pr' },
        { junk: true },
      ]),
    })

    expect(shepherdListed(exec)).toEqual(listing(['acme/widgets#7'], ['agent-chat/sa-t-2']))
  })

  it('names a checkout’s GitHub repo from its origin, ssh or https', () => {
    const at =
      (url: string): Runner =>
      () => ({ status: 0, stdout: `${url}\n` })

    expect(originRepo('/c', at('git@github.com:Acme/Widgets.git'))).toBe('Acme/Widgets')
    expect(originRepo('/c', at('https://github.com/Acme/Widgets'))).toBe('Acme/Widgets')
    expect(originRepo('/c', at('/srv/bare/widgets.git'))).toBeUndefined()
  })

  it('registers with --kind, never --offline', () => {
    const calls: string[][] = []
    const exec: Runner = (_bin, args) => {
      calls.push(args)
      return { status: 0, stdout: '' }
    }

    shepherdRegister(
      { target: { repo: 'Acme/Widgets', pr: 7 }, task: 'init/T-1', implementer: 'sa-t-1', kind: 'feature' },
      exec,
    )

    expect(calls[0]).toEqual(expect.arrayContaining(['register', 'Acme/Widgets#7', '--kind', 'feature']))
    expect(calls.flat()).not.toContain('--offline')
    expect(calls.flat()).not.toContain('--policy')
  })
})
