import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Task } from '../agents/burndown/eligibility.js'
import type { Runner } from '../agents/burndown/exec.js'
import { holdReasonRefusal } from '../agents/burndown/hold-reason.js'
import type { OwedHold } from '../agents/burndown/owed-holds.js'
import { changedFiles, openPulls, originRepo } from '../agents/burndown/pr-adopt-ports.js'
import {
  adoptSeatPrs,
  isProtectedPath,
  SENSITIVE_STEMS,
  type AdoptPorts,
  type AdoptSeat,
  type ChangedFile,
  type OpenPull,
} from '../agents/burndown/pr-adopt.js'
import {
  shepherdHold,
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
  /** Register and hold calls in order, as `register <ref>` or `hold <ref>: <reason>`. */
  calls: string[]
  seatLog: string[]
  events: string[]
  listed: ShepherdListing | undefined
  owed: OwedHold[]
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
  /** Exit codes of successive holds; past the last, a hold succeeds. */
  holdExits?: number[]
}): Fake {
  const f: Fake = {
    registered: [],
    calls: [],
    owed: [],
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
      f.calls.push(`register ${reg.target.repo}#${reg.target.pr}`)
      f.listed?.prs.add(`acme/widgets#${reg.target.pr}`)
      return { ok: true }
    },
    hold: (target, reason) => {
      f.calls.push(`hold ${target.repo}#${target.pr}: ${reason}`)
      // Shepherd refuses a reason outside charter §8 with exit 65 before it reads anything.
      if (holdReasonRefusal(reason) !== undefined) return { ok: false, refused: true, reason: 'exit 65' }
      const exit = opts.holdExits?.shift()
      return exit === undefined ? { ok: true } : { ok: false, refused: exit === 65, reason: `exit ${exit}` }
    },
    owedHolds: () => [...f.owed],
    setOwedHolds: holds => void (f.owed = [...holds]),
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

  it.each(['docs', ''])('flags a task of kind "%s" it does not register', kind => {
    const f = fake({ pulls: [pull()], tasks: [task({ tags: kind === '' ? [] : [`kind:${kind}`] })] })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toHaveLength(1)
  })

  it.each([
    ['platform', 'feature'],
    ['product', 'feature'],
    ['agent-tooling', 'feature'],
    ['bug', 'correctness'],
  ])('registers a task of kind "%s" with Shepherd kind "%s"', (kind, mapped) => {
    const f = fake({ pulls: [pull()], tasks: [task({ tags: [`kind:${kind}`] })] })

    tick(f)

    expect(f.registered.map(r => r.kind)).toEqual([mapped])
  })

  it('flags rather than registers a PR whose task it cannot find', () => {
    const f = fake({ pulls: [pull()], tasks: [] })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog).toHaveLength(1)
  })

  it.each(['security', 'gate security', 'auth_security', 'authSecurity', 'Merge_Security'])(
    'only flags a task whose title names "%s", until Shepherd holds at registration',
    word => {
      const f = fake({
        pulls: [pull()],
        tasks: [task({ title: `Fix the ${word} check`, tags: ['kind:correctness'] })],
      })

      tick(f)

      expect(f.calls).toEqual([])
      expect(f.seatLog).toHaveLength(1)
      expect(f.seatLog[0]).toMatch(
        /^burndown: Acme\/Widgets#7 unregistered: sensitive word "\w*security": register it by hand \(T-1\)$/i,
      )
    },
  )

  it('registers and then holds a PR whose title names "gate", naming the word and task', () => {
    const f = fake({ pulls: [pull({ title: 'T-1: Tidy the gate tests' })], tasks: [task()] })

    tick(f)
    tick(f)

    expect(f.calls).toEqual([
      'register Acme/Widgets#7',
      'hold Acme/Widgets#7: g10-adversary: sensitive word "gate"; T-1',
    ])
    expect(f.events).toEqual(['burndown_pr_adopt_held'])
    expect(f.seatLog).toEqual([])
  })

  it('flags for the seat once a day while a failed hold is owed', () => {
    const f = fake({
      pulls: [pull({ title: 'T-1: Tidy the gate tests' })],
      tasks: [task()],
      holdExits: [69, 69],
    })

    tick(f)
    tick(f)

    expect(f.registered).toHaveLength(1)
    expect(f.events).toEqual(['burndown_pr_adopt_hold_failed', 'burndown_pr_adopt_hold_failed'])
    expect(f.owed).toEqual([
      { seat: 'seat-a', repo: 'Acme/Widgets', pr: 7, reason: 'g10-adversary: sensitive word "gate"; T-1' },
    ])
    expect(f.seatLog).toEqual([
      'burndown: Acme/Widgets#7 not held: registered, but the hold failed (exit 69); the tick retries it, or hold it by hand: g10-adversary: sensitive word "gate"; T-1',
    ])
  })

  it('holds on the next tick a run whose hold failed after its register', () => {
    const f = fake({ pulls: [pull({ title: 'T-1: Tidy the gate tests' })], tasks: [task()], holdExits: [69] })

    tick(f)
    tick(f)

    expect(f.calls).toEqual([
      'register Acme/Widgets#7',
      'hold Acme/Widgets#7: g10-adversary: sensitive word "gate"; T-1',
      'hold Acme/Widgets#7: g10-adversary: sensitive word "gate"; T-1',
    ])
    expect(f.events.at(-1)).toBe('burndown_pr_adopt_held')
    expect(f.owed).toEqual([])
  })

  it('keeps a refused hold owed and retries it each tick while the run is listed', () => {
    const f = fake({
      pulls: [pull({ title: 'T-1: Tidy the gate tests' })],
      tasks: [task()],
      holdExits: [65, 65],
    })

    tick(f)
    tick(f)

    const reason = 'g10-adversary: sensitive word "gate"; T-1'
    expect(f.calls).toEqual([
      'register Acme/Widgets#7',
      `hold Acme/Widgets#7: ${reason}`,
      `hold Acme/Widgets#7: ${reason}`,
    ])
    expect(f.owed).toEqual([{ seat: 'seat-a', repo: 'Acme/Widgets', pr: 7, reason }])
    expect(f.events).toEqual(['burndown_pr_adopt_hold_refused', 'burndown_pr_adopt_hold_refused'])
    expect(f.seatLog).toEqual([
      `burndown: Acme/Widgets#7 unheld sensitive run: registered, but Shepherd refused the hold (exit 65); the tick retries it, but hold it by hand now: ${reason}`,
    ])
  })

  it('rewrites an owed hold with a pre-class reason to g10-adversary and retries it', () => {
    const f = fake({ pulls: [], tasks: [task()], listed: listing(['acme/widgets#7']) })
    f.owed = [
      { seat: 'seat-a', repo: 'Acme/Widgets', pr: 7, reason: 'burndown: sensitive word "gate" in T-1' },
    ]

    tick(f)

    expect(f.calls).toEqual(['hold Acme/Widgets#7: g10-adversary: sensitive word "gate"; T-1'])
    expect(f.events).toEqual(['burndown_pr_adopt_held'])
    expect(f.owed).toEqual([])
  })

  it('keeps the rewritten reason owed when its retry fails', () => {
    const f = fake({ pulls: [], tasks: [task()], listed: listing(['acme/widgets#7']), holdExits: [69] })
    f.owed = [
      { seat: 'seat-a', repo: 'Acme/Widgets', pr: 7, reason: 'burndown: sensitive word "gate" in T-1' },
    ]

    tick(f)

    expect(f.owed).toEqual([
      { seat: 'seat-a', repo: 'Acme/Widgets', pr: 7, reason: 'g10-adversary: sensitive word "gate"; T-1' },
    ])
  })

  it('drops an owed hold once Shepherd no longer lists the run, which is then not registered', () => {
    const f = fake({ pulls: [], tasks: [task()] })
    f.owed = [
      { seat: 'seat-a', repo: 'Acme/Widgets', pr: 7, reason: 'g10-adversary: sensitive word "gate"; T-1' },
    ]

    tick(f)

    expect(f.calls).toEqual([])
    expect(f.owed).toEqual([])
  })

  it('keeps an owed hold while Shepherd is down', () => {
    const owed = {
      seat: 'seat-a',
      repo: 'Acme/Widgets',
      pr: 7,
      reason: 'g10-adversary: sensitive word "gate"; T-1',
    }
    const f = fake({ pulls: [], tasks: [task()], listed: undefined })
    f.owed = [owed]

    tick(f)

    expect(f.owed).toEqual([owed])
  })

  it('does not hold when the register fails', () => {
    const f = fake({
      pulls: [pull({ title: 'T-1: Tidy the gate tests' })],
      tasks: [task()],
      registerExit: 65,
    })

    tick(f)

    expect(f.calls).toEqual([])
    expect(f.seatLog[0]).toMatch(/^burndown: Acme\/Widgets#7 refused: /)
  })

  // Mutation: building the hold reason from the word alone drops the path the seat must read.
  it('names the protected path as well as the word when a held-word PR touches one', () => {
    const f = fake({
      pulls: [pull({ title: 'T-1: Tidy the gate' })],
      tasks: [task()],
      files: [file('src/agents/gate.ts')],
    })

    tick(f)

    expect(f.calls).toEqual([
      'register Acme/Widgets#7',
      'hold Acme/Widgets#7: g10-adversary: sensitive word "gate", protected path src/agents/gate.ts; T-1',
    ])
  })

  it.each([
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
  ])('registers and holds a correctness task whose title names "%s"', word => {
    const f = fake({
      pulls: [pull()],
      tasks: [task({ title: `Fix the ${word} check`, tags: ['kind:correctness'] })],
    })

    tick(f)

    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]).toMatch(/^hold Acme\/Widgets#7: g10-adversary: sensitive word ".+"; T-1$/)
    expect(f.seatLog).toEqual([])
  })

  // Mutation: restoring the allow-list of test and doc paths flags both and registers neither.
  it.each(['src/service-check.ts', 'src/agents/burndown/eligibility.ts'])(
    'registers a mapped-kind PR whose diff touches %s, outside tests and docs',
    path => {
      const f = fake({
        pulls: [pull()],
        tasks: [task({ tags: ['kind:agent-tooling'] })],
        files: [file('src/__tests__/a.test.ts'), file(path)],
      })

      tick(f)

      expect(f.registered).toHaveLength(1)
      expect(f.registered[0]?.kind).toBe('feature')
      expect(f.seatLog).toEqual([])
    },
  )

  // Mutation: mapping every kind to `feature` registers the unmapped one.
  it('still refuses a task whose kind is unmapped, whatever its paths', () => {
    const f = fake({
      pulls: [pull()],
      tasks: [task({ tags: ['kind:docs-only'] })],
      files: [file('src/service-check.ts')],
    })

    tick(f)

    expect(f.registered).toEqual([])
    expect(f.seatLog[0]).toContain('kind "docs-only" is not one the tick registers')
  })

  // Mutation: dropping the deploy[^/]*.ts pattern leaves the deploy rows unheld.
  // Mutation: dropping a persistent-job pattern or file (systemd/, .service/.timer/.plist, deploy/hub, a named installer) leaves its row unheld.
  // Mutation: dropping the protected-path hold, or reverting a whole tree to named files, registers one of these unheld.
  it.each([
    'src/server/commands/chat-endorse.ts',
    'src/cli/verbs/permission-hook.ts',
    'src/cli/verbs/approve.ts',
    'src/agents/trust.ts',
    'src/agents/burndown/trust-gate.ts',
    'src/agents/launch-guard.ts',
    'src/agents/machine-guard.ts',
    'src/agents/process-guard.ts',
    'src/agents/isolation/worktree.ts',
    'src/gh-write/write.ts',
    'src/gh-shim/install.ts',
    'src/agents/burndown/decider.ts',
    'src/agents/burndown/owed-holds.ts',
    'src/agents/burndown/pr-adopt-ports.ts',
    'src/agents/burndown/leak-check.ts',
    'src/agents/burndown/egress-runner.ts',
    'src/agents/burndown/custody.ts',
    'src/agents/burndown/exception.ts',
    'src/agents/burndown/eligibility.ts',
    'src/agents/burndown/anything-new.ts',
    'src/agents/profiles.ts',
    'src/broker/token.ts',
    'src/broker/decisions.ts',
    'src/protocol.ts',
    'src/agents/spawn-provenance.ts',
    'src/agents/seats/spawn-gate.ts',
    'src/agents/seats/spawn-gate-check.ts',
    'src/cli/verbs/burndown-release.ts',
    '.npmrc',
    'tsconfig.json',
    'tsconfig.build.json',
    '.claude-plugin/marketplace.json',
    'src/agents/launch-plan.ts',
    'src/agents/launch-files.ts',
    'src/agents/supervisor.ts',
    'src/agents/teleport.ts',
    'src/agents/denials.ts',
    'src/server/index.ts',
    'src/server/tools.ts',
    'src/server/commands/agent-spawn.ts',
    'src/server/commands/agent-profiles.ts',
    'src/server/commands/chat-decide.ts',
    'src/cli/gh-write.ts',
    'src/spawn-kernel.ts',
    'audit/spawn-doors.json',
    '.claude/settings.json',
    '.mcp.json',
    'docs/internal/CLAUDE.md',
    'docs/claude.md',
    'AGENTS.md',
    'CLAUDE.local.md',
    'products/factory/src/shepherd/correct-verdict.ts',
    'products/factory/src/shepherd/await-verdict.ts',
    'products/factory/src/shepherd/reviewer-x.ts',
    'products/factory/src/shepherd/route-table.ts',
    'products/factory/src/shepherd/presence.ts',
    'products/factory/src/shepherd/train.ts',
    'products/factory/src/shepherd/tree-carry.ts',
    'packages/coordinator/src/seat-config.ts',
    'packages/agent/src/claude-code-adapter.ts',
    'packages/github/src/squash-cli.ts',
    'packages/agent-dispatch/src/a.ts',
    'config/generated-paths.json',
    'packages/x/src/coordinator-allowances.ts',
    'products/factory/src/owner-keys.ts',
    'products/factory/src/required-checks.ts',
    'packages/review-panel/src/accept-verdict.ts',
    'packages/review-panel/src/depth-floor.ts',
    'packages/review-panel/src/verdict-schemas.ts',
    'packages/review-panel/src/verdict-target.ts',
    'packages/review-panel/src/briefs/adversary.ts',
    'packages/daemon/src/http.ts',
    'packages/daemon/src/remote-listener.ts',
    'packages/agent-surface/src/launch-args.ts',
    'packages/agent-surface/src/run-agent.ts',
    'src/config.ts',
    'src/paths.ts',
    '.agent-chat/worktree.json',
    'src/cli/agents.ts',
    'src/cli/verbs/agent-resume.ts',
    'src/cli/index.ts',
    'src/cli/verbs/seat-broker.ts',
    'src/cli/verbs/seats.ts',
    'src/cli/verbs/seats-heartbeat.ts',
    'src/mirror/systemd-unit.ts',
    'src/mirror/systemd.ts',
    'src/mirror/launchd.ts',
    'src/mirror/plist.ts',
    '.node-version',
    'src/cli/verbs/watchdog-job.ts',
    'src/cli/verbs/mirror.ts',
    'products/factory/src/service.ts',
    'products/factory/src/service-control.ts',
    'products/factory/src/cli-service.ts',
    'products/titan/src/health/install.ts',
    'products/titan/src/health/units.ts',
    'products/titan/src/health/cli-install.ts',
    'ops/systemd/agent.service',
    'packages/anthropic-account/systemd/refresh.timer',
    'deploy/hub/compose.yml',
    'ops/launchd/job.plist',
    'systemd/unit.conf',
    'products/factory/src/deploy.ts',
    'products/factory/src/deploy-bootstrap.ts',
    'products/factory/src/deploy-checkout.ts',
    'src/agents/hooks.ts',
    'src/agents/launch-policy.ts',
    'src/agents/identity.ts',
    'src/leak-guard/scan.ts',
    'src/broker/core.ts',
    'package.json',
    'package-lock.json',
    'scripts/release.sh',
    'vitest.config.ts',
    'src/__tests__/setup.ts',
    'plugins/agent-chat/plugin.json',
    'profiles/personal/profile.json',
    'CLAUDE.md',
    '.github/workflows/ci.yml',
    'packages/authority/src/index.ts',
    'packages/tool-guard/src/a.ts',
    'packages/egress-scan/src/a.ts',
    'packages/decider/src/a.ts',
    'packages/owner-queue/src/a.ts',
    'products/factory/src/shepherd/merge-facts.ts',
    'products/factory/src/shepherd/hold-reason.ts',
    'products/factory/src/shepherd/g10-release.ts',
    'products/factory/src/shepherd/registration-policy.ts',
    'products/factory/src/shepherd/seats.ts',
    'products/factory/src/shepherd/override-gate.ts',
    'products/factory/src/shepherd/freeze-window.ts',
  ])('registers then holds a plainly titled PR whose diff touches %s', path => {
    const f = fake({
      pulls: [pull()],
      tasks: [task()],
      files: [file('src/__tests__/a.test.ts'), file(path)],
    })

    tick(f)

    expect(f.calls).toEqual([
      'register Acme/Widgets#7',
      `hold Acme/Widgets#7: g10-adversary: protected path ${path}; T-1`,
    ])
  })

  // Mutation: dropping index| or seat-broker| from the cli row registers these unheld; widening the row to src/cli/ holds the ordinary src/cli/verbs/list.ts row.
  it.each(['src/cli/index.ts', 'src/cli/verbs/seat-broker.ts'])(
    'registers then holds a PR whose only change is %s',
    path => {
      const f = fake({ pulls: [pull()], tasks: [task()], files: [file(path)] })

      tick(f)

      expect(f.calls).toEqual([
        'register Acme/Widgets#7',
        `hold Acme/Widgets#7: g10-adversary: protected path ${path}; T-1`,
      ])
    },
  )

  // Mutation: dropping an agent-launch door from the protected set fails here, so a new door cannot register unheld.
  it('protects every file audit/spawn-doors.json lists as an agent-launch door', () => {
    const { doors } = JSON.parse(
      readFileSync(new URL('../../audit/spawn-doors.json', import.meta.url), 'utf8'),
    ) as { doors: { path: string; external?: boolean }[] }

    const unprotected = doors
      .filter(d => d.external !== true)
      .map(d => d.path)
      .filter(p => !isProtectedPath(p))

    expect(doors.length).toBeGreaterThan(0)
    expect(unprotected).toEqual([])
  })

  // Mutation: a second hand-written name list in place of SENSITIVE_STEMS leaves a new stem unheld.
  it.each(SENSITIVE_STEMS)('holds a file whose name contains the sensitive stem %s', stem => {
    const sample = stem.replace('[- ]?', '').replace('(y|ie)', 'y')
    const f = fake({ pulls: [pull()], tasks: [task()], files: [file(`src/widgets/${sample}-x.ts`)] })

    tick(f)

    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]).toContain('protected path')
  })

  // Mutation: holding every non-test path, protecting all of src/, protecting all of products/factory/src, or widening the service row to service[^/]*\.ts, would hold these.
  it.each([
    'src/widgets/render.ts',
    'src/service-check.ts',
    'docs/guide.md',
    'src/cli/verbs/list.ts',
    'products/factory/src/render.ts',
    'products/factory/src/service-check.ts',
    'products/factory/src/service-ports.ts',
  ])('registers an ordinary path %s with no hold', path => {
    const f = fake({ pulls: [pull()], tasks: [task()], files: [file(path)] })

    tick(f)

    expect(f.calls).toEqual(['register Acme/Widgets#7'])
  })

  // Mutation: checking only `path` and not `previousPath` leaves a guard moved into tests unheld.
  it('holds a PR that renames a guard file into a test path', () => {
    const renamed = { ...file('src/__tests__/scan.test.ts'), previousPath: 'src/leak-guard/scan.ts' }
    const f = fake({ pulls: [pull()], tasks: [task()], files: [renamed] })

    tick(f)

    expect(f.calls).toEqual([
      'register Acme/Widgets#7',
      'hold Acme/Widgets#7: g10-adversary: protected path src/leak-guard/scan.ts; T-1',
    ])
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

  it('registers a PR that changes only tests and a changeset', () => {
    const files = ['src/__tests__/a.test.ts', '.changeset/x.md'].map(p => file(p))
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

  it('lists an open PR whose only run is cancelled, so the owner’s cancel is not undone (TP-2516)', () => {
    const exec: Runner = (_bin, args) => ({
      status: 0,
      stdout: args.includes('--all')
        ? JSON.stringify([
            { repo: 'Acme/Widgets', pr: 7, branch: 'agent-chat/sa-t-1-widget', phase: 'cancelled' },
          ])
        : '[]',
    })
    const f = fake({ pulls: [pull()], tasks: [task()], listed: shepherdListed(exec) })

    tick(f)

    expect(f.registered).toEqual([])
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

  it('holds with the reason and reads exit 65 as refused', () => {
    const calls: string[][] = []
    const exec: Runner = (_bin, args) => {
      calls.push(args)
      return { status: 65, stdout: '', stderr: 'no run for Acme/Widgets#7\n' }
    }

    const reply = shepherdHold(
      { repo: 'Acme/Widgets', pr: 7 },
      'g10-adversary: sensitive word "gate"; T-1',
      exec,
    )

    expect(calls[0]).toEqual([
      'shepherd',
      'hold',
      'Acme/Widgets#7',
      '--reason',
      'g10-adversary: sensitive word "gate"; T-1',
      '--json',
    ])
    expect(reply).toEqual({ ok: false, refused: true, reason: 'no run for Acme/Widgets#7' })
  })
})
