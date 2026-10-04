import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import type { Plan } from '../agents/burndown/plan.js'
import { collectDigest } from '../digest/collect.js'
import { reportStatus } from '../digest/ledger.js'
import type { Search } from '../digest/prs.js'
import { renderDigest } from '../digest/render.js'
import { parseSince } from '../digest/window.js'

/**
 * The digest over a fixture world: an events.db written through the real
 * EventLog, an active-work root, a burndown ledger and config, and one
 * account's status cache. Nothing here reads the developer's own files.
 */

const HOUR = 3_600_000
const NOW = new Date(2026, 8, 28, 7, 0).getTime()
const SINCE = NOW - 24 * HOUR
const EMPTY_PLAN: Plan = { dispatch: [], refusals: [], notOptedIn: [] }

let world: string
const saved = { ...process.env }

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const homeDir = (): string => path.join(world, 'home')

/** Appends through the broker's own writer, stamped `at`, so the schema is the live one. */
function ledger(rows: (Parameters<EventLog['append']>[0] & { at: number })[]): void {
  const log = new EventLog(path.join(homeDir(), 'events.db'))
  for (const { at, ...row } of rows) {
    vi.setSystemTime(at)
    log.append(row)
  }
  log.close()
  vi.setSystemTime(NOW)
}

function reading(sessionId: string, at: number, usage: { seven_day: number; five_hour: number }): void {
  const rate_limits = {
    seven_day: { used_percentage: usage.seven_day },
    five_hour: { used_percentage: usage.five_hour },
  }
  write(
    path.join(world, 'profiles', 'agents', 'status-cache', 'sessions', `${sessionId}.json`),
    JSON.stringify({ session_id: sessionId, written_at: at / 1000, rate_limits }),
  )
}

function task(slug: string, id: string, fields: string, mtime = NOW - HOUR): void {
  const file = path.join(world, 'aw', slug, 'tasks', `${id}.yml`)
  write(file, `id: ${id}\ntitle: Do ${id}\n${fields}`)
  fs.utimesSync(file, mtime / 1000, mtime / 1000)
}

const digest = (options: { plan?: Plan; search?: Search; since?: number } = {}) =>
  collectDigest({
    now: NOW,
    sinceMs: options.since ?? SINCE,
    prs: options.search !== undefined,
    ...(options.search === undefined ? {} : { search: options.search }),
    plan: () => options.plan ?? EMPTY_PLAN,
  })

const text = (options: Parameters<typeof digest>[0] = {}): string =>
  renderDigest(digest(options), 'text').join('\n')

const section = (rendered: string, title: string): string => {
  const start = rendered.indexOf(`== ${title}`)
  if (start === -1) return ''
  const end = rendered.indexOf('\n\n', start)
  return rendered.slice(start, end === -1 ? undefined : end)
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-digest-')))
  process.env.AGENT_CHAT_HOME = homeDir()
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.AGENT_CHAT_STATUS_CACHE
  write(
    path.join(homeDir(), 'burndown.config.json'),
    JSON.stringify({ accounts: { agents: { reserve_seven_day: 25, ceiling_five_hour: 70 } } }),
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('an empty world', () => {
  it('names every empty section once and says which sources were missing', () => {
    const rendered = text()

    expect(rendered).toContain(
      'Nothing in: Needs you, Decided while you were away, Milestones, Done, Stalled or failed, Exited with no Status report.',
    )
    expect(rendered).toContain('events.db: not found')
    expect(section(rendered, 'Spend')).toContain('- agents: no reading at all')
    expect(section(rendered, 'Next')).toContain(
      'nothing to dispatch: 0 refusals, 0 focused initiatives not opted in',
    )
  })

  it('renders markdown headings and code spans for the file form', () => {
    const rendered = renderDigest(digest(), 'markdown').join('\n')

    expect(rendered.startsWith('# agent-chat digest for 24h')).toBe(true)
    expect(rendered).toContain('## Spend')
    expect(rendered).toContain('`agent-chat burndown plan`')
  })
})

describe('Needs you', () => {
  it('counts only plain notices younger than the notice TTL, while old asks stay listed', () => {
    const tenDays = 10 * 24 * HOUR
    ledger([
      {
        at: NOW - tenDays,
        kind: 'question',
        actor: 'worker-a',
        target: 'human',
        msgId: 'q-old',
        body: 'Still?',
      },
      {
        at: NOW - tenDays,
        kind: 'notice',
        actor: 'worker-a',
        target: 'human',
        msgId: 'n-stale',
        body: 'old fyi',
      },
      {
        at: NOW - tenDays,
        kind: 'notice',
        actor: 'tick',
        target: 'human',
        msgId: 'n-stalled',
        body: 'worker stalled',
        meta: { kind: 'stalled' },
      },
      {
        at: NOW - HOUR,
        kind: 'notice',
        actor: 'worker-b',
        target: 'human',
        msgId: 'n-live',
        body: 'new fyi',
      },
    ])

    const needs = section(text(), 'Needs you')

    expect(needs).toContain('q-old')
    expect(needs).toContain('n-stalled')
    expect(needs).toContain('plus 1 open notices')
  })

  it('numbers open asks, kinded notices, awaiting-merge claims and needs-grant tasks in one sequence', () => {
    ledger([
      {
        at: NOW - 2 * HOUR,
        kind: 'question',
        actor: 'worker-a',
        target: 'human',
        msgId: 'q-open',
        body: 'Which schema?',
      },
      {
        at: NOW - 3 * HOUR,
        kind: 'question',
        actor: 'worker-b',
        target: 'human',
        msgId: 'q-done',
        body: 'Old?',
      },
      { at: NOW - 2 * HOUR, kind: 'answer', actor: 'human', target: 'worker-b', ref: 'q-done', body: 'yes' },
      {
        at: NOW - HOUR,
        kind: 'notice',
        actor: 'tick',
        target: 'human',
        msgId: 'n-merge',
        body: 'PR #9 approved',
        meta: { kind: 'ready-to-merge' },
      },
      { at: NOW - HOUR, kind: 'notice', actor: 'worker-a', target: 'human', msgId: 'n-plain', body: 'fyi' },
    ])
    write(
      path.join(homeDir(), 'burndown.json'),
      JSON.stringify({
        version: 1,
        claims: [
          {
            taskId: 'CC-7',
            initiative: 'demo',
            agentId: 'bd-cc-7',
            spawnedAt: '2026-09-28T01:00:00Z',
            phase: 'awaiting-merge',
            phaseAt: '2026-09-28T05:00:00Z',
          },
        ],
      }),
    )
    const plan: Plan = {
      ...EMPTY_PLAN,
      refusals: [{ initiative: 'demo', task: 'CC-8', kind: 'needs-grant', reason: 'needs grant merge' }],
    }

    const needs = section(text({ plan }), 'Needs you')

    expect(needs).toContain('== Needs you (4)')
    expect(needs).toContain('1. [ASK] q-open from worker-a, 2h ago: Which schema?')
    expect(needs).toContain('2. [NOTICE ready-to-merge] n-merge')
    expect(needs).toContain('3. CC-7: demo, bd-cc-7 awaiting merge')
    expect(needs).toContain('4. demo CC-8: needs grant merge')
    expect(needs).toContain('plus 1 open notices')
    expect(needs).not.toContain('q-done')
  })
})

describe('Decided while you were away', () => {
  const question = (id: string, at: number) =>
    ({ at, kind: 'question', actor: 'worker-a', target: 'human', msgId: id, body: `question ${id}` }) as const
  const decided = (ref: string, at: number, cls: string) =>
    ({
      at,
      kind: 'decided',
      actor: 'decider',
      target: 'worker-a',
      ref,
      body: `answer ${ref}`,
      meta: { class: cls, basis: 'policy', precedent: 'notes/decider-policy.md#R3', reversible: 'revert' },
    }) as const

  it('lists each decision with class, citation and the overrule command, and the weekly reversal rate', () => {
    ledger([
      question('q1', NOW - 5 * HOUR),
      decided('q1', NOW - 4 * HOUR, 'tech_design'),
      question('q2', NOW - 5 * HOUR),
      decided('q2', NOW - 4 * HOUR, 'tech_design'),
      { at: NOW - 3 * HOUR, kind: 'answer', actor: 'human', target: 'worker-a', ref: 'q2', body: 'no' },
      question('q-old', NOW - 50 * HOUR),
      decided('q-old', NOW - 49 * HOUR, 'agent_ops'),
    ])

    const shown = section(text(), 'Decided while you were away')

    expect(shown).toContain('== Decided while you were away (2)')
    expect(shown).toContain('- q1 for worker-a, 4h ago by decider [tech_design, policy] awaiting audit')
    expect(shown).toContain('cites: notes/decider-policy.md#R3')
    expect(shown).toContain('overrule: agent-chat answer q1 "..."')
    expect(shown).toContain('- q2 for worker-a, 4h ago by decider [tech_design, policy] overruled')
    expect(shown).not.toContain('agent-chat answer q2')
    expect(shown).not.toContain('q-old for')
    expect(shown).toContain('reversal rate, last 7 days: agent_ops 0/1 (0%), tech_design 1/2 (50%)')
  })
})

describe('Done', () => {
  it('lists tasks closed in the window with their PR references, and merged PRs when asked', () => {
    task(
      'demo',
      'CC-1',
      "status: done\ndone_at: '2026-09-28'\nnotes: shipped in PR #122 and https://github.com/o/r/pull/7\n",
    )
    task('demo', 'CC-2', 'status: done\ndone_at: 2026-08-01\n', NOW - 60 * 24 * HOUR)
    task('demo', 'CC-3', 'status: open\ndone_at: null\n')
    const search: Search = query =>
      query.includes('is:merged')
        ? { items: [{ label: 'https://github.com/o/r/pull/7', detail: 'Add x' }] }
        : { items: [] }

    const done = section(text({ search }), 'Done')

    expect(done).toContain('== Done (1 tasks, 1 merged PRs)')
    expect(done).toContain('- CC-1 Do CC-1 (demo, 2026-09-28) https://github.com/o/r/pull/7 #122')
    expect(done).toContain('- merged https://github.com/o/r/pull/7: Add x')
    expect(done).not.toContain('CC-2')
    expect(done).not.toContain('CC-3')
  })

  it('reports a failed GitHub lookup as a gap instead of failing the digest', () => {
    const rendered = text({ search: () => ({ error: 'API rate limit exceeded' }) })

    expect(section(rendered, 'Not read')).toContain('API rate limit exceeded')
    expect(rendered).toContain('== Spend')
  })
})

describe('Stalled or failed', () => {
  it('lists claims past their phase timeout and BLOCKED or NEEDS_CONTEXT reports, not prose mentions', () => {
    write(
      path.join(homeDir(), 'burndown.json'),
      JSON.stringify({
        version: 1,
        claims: [
          {
            taskId: 'CC-9',
            initiative: 'demo',
            agentId: 'bd-cc-9',
            spawnedAt: '2026-09-27T20:00:00Z',
            phase: 'implementing',
            phaseAt: new Date(NOW - 5 * HOUR).toISOString(),
          },
        ],
      }),
    )
    ledger([
      { at: NOW - HOUR, kind: 'message', actor: 'w1', target: 'coord', body: 'Status: BLOCKED on npm auth' },
      {
        at: NOW - HOUR,
        kind: 'message',
        actor: 'w2',
        target: 'coord',
        body: 'intro\n**Status:** NEEDS_CONTEXT (which repo?)',
      },
      {
        at: NOW - HOUR,
        kind: 'message',
        actor: 'r1',
        target: 'coord',
        body: 'Status: reviewed all 8 PRs, no BLOCKED.',
      },
      {
        at: NOW - 30 * HOUR,
        kind: 'message',
        actor: 'w3',
        target: 'coord',
        body: 'Status: BLOCKED long ago',
      },
    ])

    const stalled = section(text(), 'Stalled or failed')

    expect(stalled).toContain('== Stalled or failed (3)')
    expect(stalled).toContain('- CC-9 (demo) bd-cc-9 in implementing')
    expect(stalled).toContain('- BLOCKED w1 to coord, 1h ago: Status: BLOCKED on npm auth')
    expect(stalled).toContain('- NEEDS_CONTEXT w2 to coord, 1h ago: **Status:** NEEDS_CONTEXT (which repo?)')
    expect(stalled).not.toContain('r1')
    expect(stalled).not.toContain('w3')
  })

  it('recognises the status line shapes workers actually send', () => {
    expect(reportStatus('Status TP-381 (F6): BLOCKED on running.')?.status).toBe('BLOCKED')
    expect(reportStatus('TP-166 status: NEEDS_CONTEXT. No PR opened')?.status).toBe('NEEDS_CONTEXT')
    expect(reportStatus('mergeStateStatus BLOCKED (pending checks)')).toBeUndefined()
  })
})

describe('Exited with no Status report', () => {
  const exit = (at: number, agent: string, lastAction: string) => ({
    at,
    kind: 'message' as const,
    actor: 'agent-chat',
    target: 'coord',
    body: `${agent} exited with no Status report; last action: ${lastAction}`,
    meta: { event: 'unreported-exit', agent, agent_id: `id-${agent}`, last_action: lastAction },
  })

  it('groups unreported exits by UTC day and last action, with counts and agent names', () => {
    const today = NOW - HOUR
    const yesterday = NOW - 20 * HOUR
    ledger([
      exit(yesterday, 'w-old', 'Bash(run_in_background)'),
      exit(today, 'w-b', 'Bash(run_in_background)'),
      exit(today, 'w-a', 'Bash(run_in_background)'),
      exit(today, 'w-c', 'ScheduleWakeup'),
      exit(NOW - 30 * HOUR, 'w-outside', 'ScheduleWakeup'),
      { at: today, kind: 'message', actor: 'agent-chat', target: 'coord', body: 'unrelated' },
    ])
    const day = (at: number): string => new Date(at).toISOString().slice(0, 10)

    const groups = digest().ledger.unreportedExits

    expect(groups).toContainEqual({
      day: day(today),
      lastAction: 'Bash(run_in_background)',
      count: day(today) === day(yesterday) ? 3 : 2,
      agents: day(today) === day(yesterday) ? ['w-a', 'w-b', 'w-old'] : ['w-a', 'w-b'],
    })
    expect(groups).toContainEqual({
      day: day(today),
      lastAction: 'ScheduleWakeup',
      count: 1,
      agents: ['w-c'],
    })
    expect(groups.flatMap(g => g.agents)).not.toContain('w-outside')
    const rendered = section(text(), 'Exited with no Status report')
    expect(rendered).toContain('== Exited with no Status report (4)')
    expect(rendered).toContain(`- ${day(today)} ScheduleWakeup x1: w-c`)
  })
})

describe('Spend', () => {
  it('shows a fresh reading as now beside the newest reading from before the window', () => {
    reading('fresh', NOW - 5 * 60_000, { seven_day: 60, five_hour: 14 })
    reading('yesterday', SINCE - HOUR, { seven_day: 45, five_hour: 3 })

    const spend = section(text(), 'Spend')

    expect(spend).toContain(
      '- agents: now seven_day 60%, five_hour 14% (read 5m ago); 24h ago: seven_day 45%, five_hour 3% (read 25h ago)',
    )
  })

  it('marks a stale reading STALE and never presents it as current', () => {
    reading('old', NOW - 3 * HOUR, { seven_day: 60, five_hour: 14 })

    const spend = section(text(), 'Spend')

    expect(spend).toContain(
      '- agents: STALE, read 3h ago: seven_day 60%, five_hour 14%; no reading from 24h ago',
    )
    expect(spend).not.toContain('now seven_day')
  })
})

describe('Next', () => {
  it('shows what the dry-run planner would dispatch and why', () => {
    const plan: Plan = {
      ...EMPTY_PLAN,
      dispatch: [
        {
          initiative: 'demo',
          task: 'CC-4',
          profile: 'implementer',
          account: 'agents',
          cwd: '/w',
          repo: '/r',
          agentName: 'bd-cc-4',
          reason: 'priority 2, estimate 1',
        },
      ],
    }

    expect(section(text({ plan }), 'Next')).toContain(
      '- demo CC-4 as implementer on agents: priority 2, estimate 1',
    )
  })

  it('reports a planner failure as a gap', () => {
    const rendered = renderDigest(
      collectDigest({
        now: NOW,
        sinceMs: SINCE,
        prs: false,
        plan: () => {
          throw new Error('ledger malformed')
        },
      }),
      'text',
    ).join('\n')

    expect(rendered).toContain('burndown plan: ledger malformed')
    expect(section(rendered, 'Next')).toContain('the burndown planner did not run')
  })
})

describe('Milestones', () => {
  const weekFile = (): string =>
    path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy', 'milestones', '2026-W40.yml')

  it("prints one line per milestone in this week's file", () => {
    write(
      weekFile(),
      'week: 2026-W40\nappetite_days: 5\nmilestones:\n' +
        '  - {id: M1, rank: 1, seat: seat-a}\n  - {id: M2, rank: 2, seat: seat-b}\n',
    )
    task('example', 'EX-1', 'status: open\npriority: 1\nestimate: 2\ntags: [milestone:M1]\n')
    task('example', 'EX-2', 'status: open\npriority: 1\nestimate: 1\ntags: [milestone:M2]\n')

    const lines = section(text(), 'Milestones').split('\n')

    expect(lines).toEqual([
      '== Milestones (2)',
      expect.stringMatching(/^- M1 at-risk \(no points done in 3 days\): 0\/2 points done.*path 2;/),
      expect.stringMatching(/^- M2 at-risk \(no points done in 3 days\): 0\/1 points done.*path 1;/),
    ])
  })

  it('reports a malformed milestone file as a gap', () => {
    write(weekFile(), 'week: nope\n')

    expect(text()).toMatch(/- milestones: milestones\/2026-W40\.yml: schema/)
  })
})

describe('--since', () => {
  it('accepts minutes, hours and days and refuses anything else', () => {
    expect(parseSince('90m')).toBe(90 * 60_000)
    expect(parseSince('24h')).toBe(24 * HOUR)
    expect(parseSince('3d')).toBe(72 * HOUR)
    expect(() => parseSince('5x')).toThrow(/bad --since/)
    expect(() => parseSince('0h')).toThrow(/bad --since/)
  })
})
