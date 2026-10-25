import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0)
  },
}))

describe('the pretool hook after a deadline deny (CC-1409)', () => {
  it('writes the deny and exits only from the write callback, with the worker never finishing', async () => {
    const { leakPretool } = await import('../cli/verbs/leak-pretool.js')
    const events: string[] = []
    let flush: (() => void) | undefined
    const io = {
      readInput: async () => JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      write: (text: string, done: () => void) => {
        events.push(`write:${JSON.parse(text).hookSpecificOutput.permissionDecision}`)
        flush = done
      },
      exit: (code: number) => void events.push(`exit:${code}`),
    }

    vi.useFakeTimers()
    const finished = leakPretool(io)
    await vi.advanceTimersByTimeAsync(12_001)
    await finished
    vi.useRealTimers()

    expect(events).toEqual(['write:deny'])
    flush?.()
    expect(events).toEqual(['write:deny', 'exit:0'])
  })
})
