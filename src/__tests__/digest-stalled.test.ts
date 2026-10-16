import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Plan } from '../agents/burndown/plan.js'
import { collectDigest } from '../digest/collect.js'
import { renderDigest } from '../digest/render.js'

/** CC-985: the owner digest names what each stalled claim holds, its class and age, and how to release it. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = new Date(2026, 9, 14, 9, 0).getTime()
const EMPTY_PLAN: Plan = { dispatch: [], refusals: [], notOptedIn: [] }

let world: string
const saved = { ...process.env }

const iso = (at: number): string => new Date(at).toISOString()

const claim = (fields: Record<string, unknown>) => ({
  taskId: 'CC-9',
  initiative: 'demo',
  agentId: 'bd-cc-9',
  agentName: 'bd-cc-9',
  spawnedAt: iso(NOW - 6 * HOUR),
  phase: 'implementing',
  phaseAt: iso(NOW - HOUR),
  ...fields,
})

function stalledLines(claims: Record<string, unknown>[]): string[] {
  fs.writeFileSync(path.join(world, 'burndown.json'), JSON.stringify({ version: 1, claims }))
  const digest = collectDigest({ now: NOW, sinceMs: NOW - 24 * HOUR, prs: false, plan: () => EMPTY_PLAN })
  return renderDigest(digest, 'text').filter(line => line.startsWith('- CC-'))
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-digest-stalled-')))
  process.env.AGENT_CHAT_HOME = world
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('the Stalled section of the owner digest', () => {
  it('marks a 3 h stall whose agent is gone as aged, holding only its task, with its release command', () => {
    const lines = stalledLines([
      claim({
        slice: 'b',
        stalledReason: 'worker exited with no PR',
        stalledClass: 'failed',
        stalledAt: iso(NOW - 3 * HOUR),
        stale: { class: 'retry-spent', proposed: 'release the claim', since: iso(NOW - 2 * HOUR) },
      }),
    ])

    expect(lines).toEqual([
      '- CC-9 (demo) bd-cc-9 in implementing, stalled 3h, aged, holds: task, class failed: ' +
        'worker exited with no PR; retry-spent: release the claim; ' +
        'release: agent-chat burndown release CC-9 --slice b',
    ])
  })

  it('lists a 30 min stall with a live-looking agent as holding its lane, not aged', () => {
    const lines = stalledLines([
      claim({ stalledReason: 'gate tripped', stalledClass: 'gate-trip', stalledAt: iso(NOW - 30 * MINUTE) }),
    ])

    expect(lines).toEqual([
      '- CC-9 (demo) bd-cc-9 in implementing, stalled 30m, holds: lane + task, class gate-trip: gate tripped; ' +
        'release: agent-chat burndown release CC-9',
    ])
  })

  it('keeps the phase-timeout wording only for a claim that outlived its phase with no recorded reason', () => {
    const lines = stalledLines([claim({ phaseAt: iso(NOW - 5 * HOUR) })])

    expect(lines).toEqual([
      `- CC-9 (demo) bd-cc-9 in implementing, stalled 5h, aged, holds: lane + task, class unclassed: ` +
        `since ${iso(NOW - 5 * HOUR)}, past its phase timeout; release: agent-chat burndown release CC-9`,
    ])
  })

  it('omits a done claim even when it carries a stall reason', () => {
    const lines = stalledLines([
      claim({ phase: 'done', stalledReason: 'old', stalledAt: iso(NOW - 9 * HOUR) }),
    ])

    expect(lines).toEqual([])
  })
})
