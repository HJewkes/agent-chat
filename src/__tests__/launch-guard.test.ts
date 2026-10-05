import { describe, expect, it } from 'vitest'
import { holderOf, type LaunchProbe } from '../agents/launch-guard.js'

const probe = (over: Partial<LaunchProbe> = {}): LaunchProbe => ({
  isAlive: () => true,
  readArgv: () => undefined,
  sessionRecords: () => [],
  listProcesses: () => [],
  ...over,
})

describe('holderOf (CC-488)', () => {
  it('names another run-agent process for the same agent', () => {
    const listProcesses = () => [
      { pid: 10, command: 'node cli.js run-agent agt-1' },
      { pid: 11, command: 'node cli.js run-agent agt-2' },
    ]

    expect(holderOf('agt-1', 'S', [], probe({ listProcesses }))).toBe(10)
  })

  it('ignores its own pid and its parent', () => {
    const listProcesses = () => [{ pid: 10, command: 'node cli.js run-agent agt-1' }]

    expect(holderOf('agt-1', 'S', [10], probe({ listProcesses }))).toBeUndefined()
  })

  it('names a live Claude Code session record holding the session id', () => {
    const sessionRecords = () => [
      { pid: 20, sessionId: 'S' },
      { pid: 21, sessionId: 'other' },
    ]

    expect(holderOf('agt-1', 'S', [], probe({ sessionRecords }))).toBe(20)
  })

  it('ignores a session record whose pid is gone', () => {
    const sessionRecords = () => [{ pid: 20, sessionId: 'S' }]

    expect(holderOf('agt-1', 'S', [], probe({ sessionRecords, isAlive: () => false }))).toBeUndefined()
  })
})
