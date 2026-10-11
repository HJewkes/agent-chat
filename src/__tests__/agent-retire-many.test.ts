import { describe, expect, it, vi } from 'vitest'
import { agentRetire } from '../cli/verbs/agent-retire.js'
import type { VerbContext } from '../cli/command.js'

/** CC-888: several names in one call, each judged on its own. */

const REPLIES: Record<string, { ok: boolean; reason?: string }> = {
  done: { ok: true },
  ghost: { ok: false, reason: 'no such agent: ghost' },
  busy: { ok: false, reason: 'still running; pass --force' },
}

function ctxWithReplies() {
  const request = vi.fn(async (frame: { name: string }) => ({ t: 'spawn_result', ...REPLIES[frame.name] }))
  const ctx = { withBroker: (fn: (b: unknown) => unknown) => fn({ request }) } as unknown as VerbContext
  return { request, ctx }
}

describe('agent retire with several names', () => {
  it('prints one result line per name and fails when any failed', async () => {
    const { request, ctx } = ctxWithReplies()

    const report = await agentRetire.run({ name: ['done', 'ghost', 'busy'] }, ctx)

    expect(report).toEqual({
      ok: false,
      lines: [
        'Retired done.',
        'Not retired ghost: no such agent: ghost',
        'Not retired busy: still running; pass --force',
      ],
    })
    expect(request.mock.calls.map(c => c[0].name)).toEqual(['done', 'ghost', 'busy'])
  })

  it('succeeds when every name was retired', async () => {
    const { ctx } = ctxWithReplies()

    const report = await agentRetire.run({ name: ['done', 'done'] }, ctx)

    expect(report.ok).toBe(true)
    expect(report.lines).toEqual(['Retired done.', 'Retired done.'])
  })

  it('keeps the single-name output exactly as before', async () => {
    const { ctx } = ctxWithReplies()

    expect(await agentRetire.run({ name: ['ghost'] }, ctx)).toEqual({
      ok: false,
      lines: ['Not retired: no such agent: ghost'],
    })
  })
})
