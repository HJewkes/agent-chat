import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecycleVerifier, listGit, listWorktrees } from '../agents/ledger/verifier.js'
import type { VerifyInput } from '../agents/ledger/verify.js'

/**
 * CC-118 slice 4: the broker's five-minute verifier tick. Fake timers, a fake
 * gather, and a git lister that fails the way an absent git binary does.
 */

const MINUTE = 60_000

function input(gitListings: VerifyInput['gitListings']): VerifyInput {
  return {
    fold: [],
    ledgerActive: [],
    ledgerTerminalByAgent: new Map(),
    runtimeRefs: [{ agentId: 'a', branch: 'agent-chat/a', gitRoot: '/repo' }],
    gitListings,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('LifecycleVerifier tick', () => {
  it('runs every five minutes, never before 60 s after listen, and survives git being absent', async () => {
    const absentGit = vi.fn(async (_gitRoot: string): Promise<string> => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    })
    const gather = vi.fn(async () => ({
      input: input(await listGit(input([]).runtimeRefs, async root => absentGit(root).catch(() => null))),
      shadow: 'on' as const,
    }))
    const log = vi.fn()
    const verifier = new LifecycleVerifier({ gather, shadowErrors: () => 0, log })

    verifier.start()
    await vi.advanceTimersByTimeAsync(MINUTE - 1)
    const beforeFirst = gather.mock.calls.length
    await vi.advanceTimersByTimeAsync(1)
    const afterFirst = gather.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    verifier.stop()

    expect(beforeFirst).toBe(0)
    expect(afterFirst).toBe(1)
    expect(gather).toHaveBeenCalledTimes(3)
    expect(absentGit).toHaveBeenCalledTimes(3)
    expect(verifier.summary()).toMatchObject({ shadow: 'on', unclassified: 0, shadow_errors: 0 })
    expect(log).toHaveBeenCalledWith('lifecycle_verify', { classified: 0, unclassified: 0, shadowErrors: 0 })
  })

  it('logs a failed run instead of throwing, and keeps ticking', async () => {
    const gather = vi
      .fn()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue({
        input: input([]),
        shadow: 'on',
      })
    const log = vi.fn()
    const verifier = new LifecycleVerifier({ gather, shadowErrors: () => 2, log })

    verifier.start()
    await vi.advanceTimersByTimeAsync(6 * MINUTE)
    verifier.stop()

    expect(log).toHaveBeenCalledWith('lifecycle_verify_error', { reason: 'Error: database is locked' })
    expect(verifier.summary()).toMatchObject({ shadow_errors: 2 })
  })

  it('renews leases on each tick, before the check', async () => {
    const order: string[] = []
    const verifier = new LifecycleVerifier({
      gather: async () => (order.push('check'), { input: input([]), shadow: 'on' }),
      renew: async () => void order.push('renew'),
      shadowErrors: () => 0,
      log: vi.fn(),
    })

    verifier.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    verifier.stop()

    expect(order).toEqual(['renew', 'check'])
  })

  it('lists a repository git cannot run in as null rather than throwing', async () => {
    vi.useRealTimers()

    expect(await listWorktrees('/nonexistent/agent-chat-verify')).toBeNull()
  })

  it('has no summary before its first run', () => {
    const verifier = new LifecycleVerifier({ gather: vi.fn(), shadowErrors: () => 0, log: vi.fn() })

    expect(verifier.summary()).toBeUndefined()
  })
})
