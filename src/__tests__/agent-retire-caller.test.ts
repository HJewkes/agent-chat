import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRetire } from '../cli/verbs/agent-retire.js'
import type { VerbContext } from '../cli/command.js'

/** CC-218: the one-shot CLI connection is anonymous, so the frame carries the caller. */

function sentFrame(): { request: ReturnType<typeof vi.fn>; ctx: VerbContext } {
  const request = vi.fn().mockResolvedValue({ t: 'spawn_result', ok: true })
  const ctx = { withBroker: (fn: (b: unknown) => unknown) => fn({ request }) } as unknown as VerbContext
  return { request, ctx }
}

afterEach(() => {
  delete process.env.AGENT_CHAT_NAME
})

describe('agent retire caller', () => {
  it('sends the session name when run from an agent session', async () => {
    process.env.AGENT_CHAT_NAME = 'coord-x'
    const { request, ctx } = sentFrame()

    await agentRetire.run({ name: ['worker-1'] }, ctx)

    expect(request.mock.calls[0]?.[0]).toEqual({ t: 'retire', name: 'worker-1', caller: 'coord-x' })
  })

  it('sends no caller from a shell with no agent identity', async () => {
    const { request, ctx } = sentFrame()

    await agentRetire.run({ name: ['worker-1'] }, ctx)

    expect(request.mock.calls[0]?.[0]).toEqual({ t: 'retire', name: 'worker-1' })
  })
})
