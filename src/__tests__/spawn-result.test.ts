import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { expectSpawned } from './helpers/spawn-result.js'

describe('a spawn that never completes', () => {
  it('fails naming the spawn error instead of returning undefined output', () => {
    const result = spawnSync('/nonexistent/agent-chat-cc-462', [], { encoding: 'utf8' })

    expect(() => expectSpawned(result, 'missing tool')).toThrow(/missing tool did not complete: .*ENOENT/)
  })

  it('reports the signal and the stderr written before a timeout killed it', () => {
    const result = spawnSync('/bin/sh', ['-c', 'echo partial >&2; sleep 30'], {
      encoding: 'utf8',
      timeout: 2_000,
    })

    expect(() => expectSpawned(result, 'slow tool')).toThrow(
      /ETIMEDOUT \(status null, signal SIGTERM\)\nstderr: partial/,
    )
  })

  it('returns a completed result unchanged, whatever its exit status', () => {
    const result = spawnSync('/bin/sh', ['-c', 'echo out; exit 3'], { encoding: 'utf8' })

    expect(expectSpawned(result, 'failing tool')).toBe(result)
  })
})
