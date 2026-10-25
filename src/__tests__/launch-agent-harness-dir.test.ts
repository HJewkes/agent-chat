import { describe, expect, it, vi } from 'vitest'
import { launchExitHook } from '../agents/launch-agent.js'

const HOME = '/home/example'

describe('the harness dir at run-agent exit (CC-1266)', () => {
  it('removes the scratch dir and the harness dir of the launch', () => {
    const removeTmp = vi.fn()
    const hook = launchExitHook(
      'a1',
      'worker',
      '/tmp',
      { reap: vi.fn(), removeTmp, removeKey: vi.fn() },
      HOME,
    )

    hook()

    expect(removeTmp.mock.calls.map(call => [call[0], call[1], call[2], call[4]])).toEqual([
      ['worker', 'a1', process.pid, '/tmp'],
      ['worker', 'a1', process.pid, `${HOME}/.cache/agent-chat/harness`],
    ])
  })

  it('removes neither when the launch has no name', () => {
    const removeTmp = vi.fn()
    const reap = vi.fn()
    const hook = launchExitHook('a1', undefined, '/tmp', { reap, removeTmp, removeKey: vi.fn() }, HOME)

    hook()

    expect(reap).toHaveBeenCalledOnce()
    expect(removeTmp).not.toHaveBeenCalled()
  })
})
