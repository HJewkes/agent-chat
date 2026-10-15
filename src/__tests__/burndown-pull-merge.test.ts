import { describe, expect, it } from 'vitest'
import type { RunResult } from '../agents/burndown/exec.js'
import { pullMergeReader, readPullMerge } from '../agents/burndown/pr-state.js'

/** CC-1044: one PR's merge read by number, so the 100-PR page limit cannot hide a merge from the tick. */

const TARGET = { repo: 'o/r', pr: 9 }

const answering = (reply: RunResult) => {
  const calls: string[][] = []
  const exec = (bin: string, args: string[]): RunResult => {
    calls.push([bin, ...args])
    return reply
  }
  return { exec, calls }
}

const ok = (body: unknown): RunResult => ({ status: 0, stdout: `${JSON.stringify(body)}\n` })

describe('readPullMerge', () => {
  it('reads a merged PR with its merge time and head from the single-PR endpoint', () => {
    const gh = answering(ok({ mergedAt: '2026-10-11T11:00:00Z', headSha: 'h9' }))

    const read = readPullMerge(TARGET, gh.exec)

    expect(read).toEqual({ mergedAt: '2026-10-11T11:00:00Z', headSha: 'h9' })
    expect(gh.calls[0]?.slice(0, 3)).toEqual(['gh', 'api', 'repos/o/r/pulls/9'])
  })

  it('reads an open PR as unmerged rather than unknown', () => {
    const gh = answering(ok({ mergedAt: null, headSha: 'h9' }))

    expect(readPullMerge(TARGET, gh.exec)).toEqual({ mergedAt: null, headSha: 'h9' })
  })

  it('reads nothing when gh fails', () => {
    const gh = answering({ status: 1, stdout: '' })

    expect(readPullMerge(TARGET, gh.exec)).toBeUndefined()
  })

  it('reads nothing when gh answers with a line that is not JSON', () => {
    const gh = answering({ status: 0, stdout: 'rate limited\n' })

    expect(readPullMerge(TARGET, gh.exec)).toBeUndefined()
  })

  it('reads nothing when the answer has no head sha', () => {
    const gh = answering(ok({ mergedAt: '2026-10-11T11:00:00Z', headSha: null }))

    expect(readPullMerge(TARGET, gh.exec)).toBeUndefined()
  })
})

describe('pullMergeReader', () => {
  it('asks GitHub once per PR however many claims ask about it in a tick', () => {
    const gh = answering(ok({ mergedAt: null, headSha: 'h9' }))
    const read = pullMergeReader(gh.exec)

    read(TARGET)
    read({ ...TARGET })
    read({ repo: 'o/r', pr: 10 })

    expect(gh.calls.map(c => c[2])).toEqual(['repos/o/r/pulls/9', 'repos/o/r/pulls/10'])
  })

  it('remembers a failed read for the tick instead of retrying it', () => {
    const gh = answering({ status: 1, stdout: '' })
    const read = pullMergeReader(gh.exec)

    expect(read(TARGET)).toBeUndefined()
    expect(read(TARGET)).toBeUndefined()

    expect(gh.calls).toHaveLength(1)
  })
})
