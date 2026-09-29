import { describe, expect, it } from 'vitest'
import { isLaunchedProcess } from '../server/host.js'

const LAUNCHER = 4000
const LAUNCHED_CLAUDE = 4001
const NESTED_CLAUDE = 4003
const parents = new Map([
  [LAUNCHED_CLAUDE, LAUNCHER],
  [4002, LAUNCHED_CLAUDE],
  [NESTED_CLAUDE, 4002],
])
const parentOf = (pid: number): number | undefined => parents.get(pid)
const env = { AGENT_CHAT_LAUNCHER_PID: String(LAUNCHER) }

describe('whether a Claude Code process may use the spawn identity in its environment', () => {
  it('accepts the process run-agent launched', () => {
    expect(isLaunchedProcess(env, LAUNCHED_CLAUDE, parentOf)).toBe(true)
  })

  it('refuses a claude started from a shell inside the launched agent', () => {
    expect(isLaunchedProcess(env, NESTED_CLAUDE, parentOf)).toBe(false)
  })

  it('refuses when the host process cannot be identified', () => {
    expect(isLaunchedProcess(env, undefined, parentOf)).toBe(false)
  })

  it('refuses when the host has no discoverable parent', () => {
    expect(isLaunchedProcess(env, 9999, parentOf)).toBe(false)
  })

  it('trusts an agent from an older run-agent that stamps no launcher pid', () => {
    expect(isLaunchedProcess({}, NESTED_CLAUDE, parentOf)).toBe(true)
  })
})
