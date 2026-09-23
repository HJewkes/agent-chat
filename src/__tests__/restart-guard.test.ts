import { describe, expect, it } from 'vitest'
import { ATTACH_CEILING_MS } from '../agents/supervisor.js'
import { guardRestart, type BlockerSource } from '../cli/restart-guard.js'
import type { AgentIdentity, AgentLifecycle, QueueItem } from '../protocol.js'

const NOW = 1_000_000_000

const agent = (name: string, state: AgentLifecycle, ageMs = 1_000): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state,
  origin: 'spawned',
  spawnedBy: 'coordinator',
  spawnedAt: NOW - ageMs,
  brief: '',
  cwd: '/tmp',
  isolation: 'none',
  surface: 'headless',
  sessionId: '',
  lastEventAt: NOW - ageMs,
  generation: 1,
})

const item = (kind: QueueItem['kind'], from: string, text: string): QueueItem => ({
  msgId: `m-${from}`,
  kind,
  from,
  text,
  at: NOW,
  meta: {},
})

const source = (agents: AgentIdentity[], queue: QueueItem[]): BlockerSource => ({
  agents: async () => agents,
  queue: async () => queue,
})

describe('service restart guard', () => {
  it('refuses while an agent is mid-spawn and names it', async () => {
    const refusal = await guardRestart(
      'restart',
      source([agent('cc-new', 'spawning'), agent('cc-old', 'live')], []),
      {
        now: NOW,
      },
    )

    expect(refusal).toContain('refusing to restart')
    expect(refusal).toContain('mid-spawn: cc-new')
    expect(refusal).not.toContain('cc-old')
    expect(refusal).toContain('Use --force to restart anyway.')
  })

  it('refuses while an ask to the human is unanswered and quotes it', async () => {
    const refusal = await guardRestart(
      'restart',
      source([], [item('question', 'cc-worker', 'Should I   merge\nthe PR now?')]),
      { now: NOW },
    )

    expect(refusal).toContain('unanswered ask from cc-worker: "Should I merge the PR now?"')
  })

  it('shortens a long ask to an excerpt', async () => {
    const refusal = await guardRestart(
      'restart',
      source([], [item('question', 'cc-worker', 'x'.repeat(500))]),
      {
        now: NOW,
      },
    )

    expect(refusal).not.toContain('x'.repeat(100))
  })

  it('goes ahead with --force even when work is in flight', async () => {
    const busy = source([agent('cc-new', 'spawning')], [item('question', 'cc-worker', 'ok?')])

    expect(await guardRestart('restart', busy, { force: true, now: NOW })).toBeNull()
  })

  it('goes ahead when nothing is pending', async () => {
    const quiet = source(
      [agent('cc-live', 'live'), agent('cc-done', 'exited')],
      [item('notice', 'cc-live', 'fyi')],
    )

    expect(await guardRestart('restart', quiet, { now: NOW })).toBeNull()
  })

  it('ignores a spawn orphaned past the attach ceiling, since no live wait remains to lose', async () => {
    const orphan = source([agent('cc-ghost', 'spawning', ATTACH_CEILING_MS + 1)], [])

    expect(await guardRestart('restart', orphan, { now: NOW })).toBeNull()
  })

  it('names the verb it refuses so stop reads correctly', async () => {
    const refusal = await guardRestart('stop', source([agent('cc-new', 'spawning')], []), { now: NOW })

    expect(refusal).toMatch(/^refusing to stop/)
    expect(refusal).toContain('Use --force to stop anyway.')
  })
})
