import { describe, expect, it } from 'vitest'
import { backoffHeld } from '../agents/burndown/backoff.js'
import { briefRefusal, pickTask, taskRefusal, type Task } from '../agents/burndown/eligibility.js'
import type { Ledger } from '../agents/burndown/ledger.js'

const NOW = new Date('2026-10-01T12:00:00.000Z')

const task = (id: string, priority: number): Task => ({
  id,
  title: `Do ${id}`,
  status: 'open',
  priority,
  estimate: 1,
  doneWhen: 'unit tests cover it',
  tags: [],
})

const ledger: Ledger = { version: 1, claims: [], releases: { 'X-1': { n: 2, at: NOW.toISOString() } } }
const initiative = {
  slug: 'demo',
  autonomy: { mode: 'burndown' as const, lanes: 1, accounts: [], grants: [] },
}

describe('eligibility under release backoff', () => {
  it('refuses only the held task and leaves a task with no release record eligible', () => {
    const held = backoffHeld(ledger, NOW)

    expect(taskRefusal(task('X-1', 1), [], new Set(), held)?.kind).toBe('backoff')
    expect(taskRefusal(task('Y-1', 2), [], new Set(), held)).toBeUndefined()
  })

  it('picks the next task when the higher-priority one is held', () => {
    const picked = pickTask(initiative, [task('X-1', 1), task('Y-1', 2)], new Set(), backoffHeld(ledger, NOW))

    expect(picked.task?.id).toBe('Y-1')
    expect(picked.refusals).toEqual([
      expect.objectContaining({
        task: 'X-1',
        kind: 'backoff',
        reason: expect.stringContaining('released 2 times'),
      }),
    ])
  })
})

describe('eligibility under the brief gate (CC-925)', () => {
  const brief = (gate: 'off' | 'shadow' | 'on') => ({ gate, maxAgeDays: 14, now: NOW })
  const tagged = (...tags: string[]): Task => ({ ...task('B-1', 1), tags })

  it('refuses an untagged task as no-brief only when the gate is on', () => {
    expect(taskRefusal(tagged(), [], new Set(), new Map(), brief('on'))?.kind).toBe('no-brief')
    expect(taskRefusal(tagged(), [], new Set(), new Map(), brief('shadow'))).toBeUndefined()
    expect(taskRefusal(tagged(), [], new Set(), new Map(), brief('off'))).toBeUndefined()
    expect(taskRefusal(tagged(), [], new Set())).toBeUndefined()
  })

  it('refuses a brief older than briefMaxAgeDays as brief-stale, and keeps one exactly that old', () => {
    const stale = taskRefusal(tagged('brief:ready=2026-09-16'), [], new Set(), new Map(), brief('on'))

    expect(stale).toEqual({ kind: 'brief-stale', reason: expect.stringContaining('15 days old') })
    expect(
      taskRefusal(tagged('brief:ready=2026-09-17'), [], new Set(), new Map(), brief('on')),
    ).toBeUndefined()
  })

  it('reads a malformed brief:ready tag as no brief', () => {
    expect(briefRefusal(tagged('brief:ready=2026-13-01'), brief('on'))?.kind).toBe('no-brief')
  })

  it('lets an earlier refusal win over the brief gate', () => {
    expect(taskRefusal(tagged(), [], new Set(['B-1']), new Map(), brief('on'))?.kind).toBe('claimed')
  })
})
