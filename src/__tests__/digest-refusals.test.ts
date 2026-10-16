import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { opsGap, type Refusal } from '../agents/burndown/eligibility.js'
import { opsNoneTag } from '../agents/burndown/ops.js'
import type { Plan } from '../agents/burndown/plan.js'
import { collectDigest } from '../digest/collect.js'
import { ownerRefusals } from '../digest/refusals.js'
import { renderDigest } from '../digest/render.js'

/** CC-1007: the digest's Needs you lists the CC-974 refusals the owner or a brief fix must clear. */

const HOUR = 3_600_000
const NOW = new Date(2026, 9, 14, 9, 0).getTime()
const PROSE_DONE_WHEN =
  'the fix is deployed to production and the broker restart is done after we publish the package'

let world: string
const saved = { ...process.env }

const refusal = (task: string, kind: Refusal['kind'], reason: string): Refusal => ({
  initiative: 'demo',
  task,
  kind,
  reason,
})

const proseRefusal = (): Refusal => {
  const gap = opsGap({ doneWhen: PROSE_DONE_WHEN, tags: [] }, [])
  if (gap === undefined) throw new Error('the prose done_when no longer trips the ops lint')
  return refusal('CC-3', gap.kind, gap.reason)
}

function needsYou(refusals: Refusal[]): string[] {
  const plan: Plan = { dispatch: [], refusals, notOptedIn: [] }
  const digest = collectDigest({ now: NOW, sinceMs: NOW - 24 * HOUR, prs: false, plan: () => plan })
  const lines = renderDigest(digest, 'text')
  const start = lines.findIndex(line => line.startsWith('== Needs you'))
  const end = lines.findIndex((line, i) => i > start && line.startsWith('== '))
  return lines.slice(start, end === -1 ? undefined : end)
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-digest-refusals-')))
  process.env.AGENT_CHAT_HOME = world
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('the owner-held refusals in the digest', () => {
  it('lists a needs-human refusal with its task id and declared op', () => {
    const held = ownerRefusals([refusal('CC-1', 'needs-human', 'declares ops:deploy')])

    expect(held).toEqual([{ label: 'demo CC-1', detail: '[needs-human] declares ops:deploy' }])
  })

  it('lists a human-step refusal routed to the owner', () => {
    const held = ownerRefusals([refusal('CC-2', 'human-step', 'routed to the owner, never dispatched')])

    expect(held).toEqual([
      { label: 'demo CC-2', detail: '[human-step] routed to the owner, never dispatched' },
    ])
  })

  it("puts an ops-unresolved refusal's ops:none tag inside the rendered line", () => {
    const prose = proseRefusal()
    const tag = opsNoneTag(PROSE_DONE_WHEN)
    expect(prose.reason.indexOf(tag)).toBeGreaterThan(100)

    const lines = needsYou([prose])

    expect(lines.find(line => line.startsWith('1. demo CC-3: [ops-unresolved]'))).toContain(tag)
  })

  it('shows a publish-mixed ops-unresolved refusal without inventing a tag', () => {
    const reason = 'ops:publish task is not publish-only (its done_when is not exactly a publish)'

    const held = ownerRefusals([refusal('CC-4', 'ops-unresolved', reason)])

    expect(held).toEqual([{ label: 'demo CC-4', detail: `[ops-unresolved] ${reason}` }])
  })

  it('leaves needs-grant and other refusal kinds out of the held list', () => {
    const held = ownerRefusals([
      refusal('CC-5', 'needs-grant', 'needs grant merge-on-green-approve'),
      refusal('CC-6', 'lanes-full', 'lanes are full'),
      refusal('CC-7', 'claimed', 'already claimed'),
    ])

    expect(held).toEqual([])
  })

  it('numbers held items after needs-grant items in Needs you', () => {
    const lines = needsYou([
      refusal('CC-2', 'human-step', 'routed to the owner, never dispatched'),
      refusal('CC-5', 'needs-grant', 'needs grant merge-on-green-approve'),
    ])

    expect(lines).toEqual([
      '== Needs you (2)',
      'Needs a grant in the brief:',
      '1. demo CC-5: needs grant merge-on-green-approve',
      'Held for you or a brief fix:',
      '2. demo CC-2: [human-step] routed to the owner, never dispatched',
      '',
    ])
  })
})
