import { describe, expect, it } from 'vitest'
import { emptySeatState, type SeatState } from '@titan-design/coordinator'
import { renderSeatState, type SeatStateRenderInput } from '../agents/seats/seat-state-render.js'
import type { DispatchRecord } from '../agents/seats/dispatch-record.js'
import type { FlightPr, InFlight } from '../agents/seats/in-flight-read.js'

const NOW = Date.parse('2026-10-14T12:00:00Z')

const AUTHORED = [
  'Continuations',
  '- on pr HJewkes/agent-chat#900: merge on MERGE verdict',
  '- on agent tc-x-a: review its PR',
  'Next/why',
  'drain the TP-1600 slices before new work',
].join('\n')

const pr = (n: number): FlightPr => ({
  pr: `HJewkes/agent-chat#${n}`,
  head: `abcdef12${n}`,
  verdict: 'MERGE',
  verdictHead: null,
  ci: 'green',
  phase: 'await-verdict',
  task: `TP-${n}`,
  agent: null,
  claim: null,
  nextAction: null,
  pendingGate: null,
  flags: [],
})

const record = (agent: string, ts: string): DispatchRecord =>
  ({
    ts,
    agent,
    task: 'TP-1',
    outcome: 'done',
    tokens: 10,
    usage_partial: false,
    usd_est: 0.1,
    pr: null,
    score: null,
  }) as DispatchRecord

const state = (over: Partial<SeatState> = {}): SeatState => ({
  ...emptySeatState(),
  generation: 2,
  holds: [{ target: 'platform-coord', reason: 'restart window' }],
  background: [{ id: 'ci-watch', command: 'gh run watch 42', cwd: '/Users/me/projects/agent-chat' }],
  ...over,
})

const inFlight = (prs: FlightPr[]): InFlight => ({ prs, agents: [], claims: [], unavailable: [] })

const input = (over: Partial<SeatStateRenderInput> = {}): SeatStateRenderInput => ({
  state: state(),
  authored: AUTHORED,
  inFlight: inFlight([pr(1), pr(2), pr(3)]),
  worktreeClaims: [{ owner: 'tc-x-a', worktree: '/w/tc-x-a', patterns: ['src/**'] }],
  pace: {
    found: true,
    pools: new Map([['personal', { behind: 4, readingAt: NOW - 30 * 60_000, fiveHour: 41 }]]),
  },
  recent: [record('tc-old', '2026-10-14T09:00:00Z'), record('tc-new', '2026-10-14T11:00:00Z')],
  now: NOW,
  ...over,
})

const headings = (lines: string[]): string[] =>
  lines.filter(l => l.startsWith('== ')).map(l => l.split(' ')[1])

describe('renderSeatState', () => {
  it('lists every section in prompt order with relaunch lines and reading age', () => {
    const lines = renderSeatState(input())

    expect(headings(lines)).toEqual(['authored', 'in', 'worktree', 'holds', 'background', 'budget', 'recent'])
    expect(lines.join('\n')).toContain(AUTHORED)
    expect(lines.filter(l => l.startsWith('pr '))).toHaveLength(3)
    expect(lines).toContain('claim /w/tc-x-a | owner tc-x-a | src/**')
    expect(lines).toContain('hold platform-coord: restart window')
    expect(lines).toContain('background ci-watch | cd /Users/me/projects/agent-chat && gh run watch 42')
    expect(lines).toContain('pool personal | 4 pts behind pace | 5h 41% | reading 30 min old')
  })

  it('shows the newest recent outcome first', () => {
    const lines = renderSeatState(input())

    const recent = lines.filter(l => l.includes('TP-1  done'))
    expect(recent[0]).toContain('tc-new')
    expect(recent[1]).toContain('tc-old')
  })

  it('quotes a background cwd the shell would split', () => {
    const lines = renderSeatState(
      input({ state: state({ background: [{ id: 'w', command: 'tail -f x', cwd: '/a b' }] }) }),
    )

    expect(lines).toContain("background w | cd '/a b' && tail -f x")
  })

  it('names a source it could not read and the fold problems', () => {
    const lines = renderSeatState(
      input({
        pace: { found: false, reason: 'pace.json is missing' },
        recent: { unavailable: 'no dispatch log' },
        state: state({
          errors: [{ index: 3, kind: 'background', message: 'cwd under /tmp' }],
          unknownEvents: 1,
        }),
      }),
    )

    expect(lines).toContain('unavailable: budget (pace.json is missing)')
    expect(lines).toContain('unavailable: recent (no dispatch log)')
    expect(lines).toContain('event 3 (background): cwd under /tmp')
    expect(lines).toContain('1 events of an unknown kind skipped')
  })

  it('falls back to the stored authored text and marks an empty block', () => {
    const stored = renderSeatState(input({ authored: undefined, state: state({ authored: 'raw block' }) }))
    const empty = renderSeatState(input({ authored: '' }))

    expect(stored).toContain('raw block')
    expect(empty).toContain('authored: none')
  })

  it('cuts Recent before Budget and keeps the authored block whole under a tight cap', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      record(`tc-${i}`, `2026-10-14T10:${String(i).padStart(2, '0')}:00Z`),
    )
    const full = renderSeatState(input({ recent: many }), 100_000).join('\n')

    const capped = renderSeatState(input({ recent: many }), 1_400).join('\n')

    expect(full.length).toBeGreaterThan(1_400)
    expect(capped.length).toBeLessThanOrEqual(1_400)
    expect(capped).toContain(AUTHORED)
    expect(capped).toContain('pool personal')
    expect(capped).toContain('[cut at')
    expect(capped).not.toContain('tc-0 ')
  })

  it('never cuts the authored block even when it alone exceeds the cap', () => {
    const long = `Continuations\n${'- on time 18:00: check the merge queue\n'.repeat(40)}`

    const lines = renderSeatState(input({ authored: long }), 1_000).join('\n')

    expect(lines).toContain(long.trim())
    expect(lines).toContain('hold platform-coord: restart window')
    expect(lines).toContain('background ci-watch')
  })
})
