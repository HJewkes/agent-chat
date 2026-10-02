import { afterEach, describe, expect, it } from 'vitest'
import { isLaunchedProcess, psParentOf } from '../server/host.js'
import { launchEnv } from '@titan-design/agent-surface'
import { LAUNCHER_PID_ENV } from '../agents/launcher.js'

const LAUNCHER = 4000
const LAUNCHED_CLAUDE = 4001
const NESTED_CLAUDE = 4003
const WRAPPED_CLAUDE = 4005
const parents = new Map([
  [LAUNCHED_CLAUDE, LAUNCHER],
  [4002, LAUNCHED_CLAUDE],
  [NESTED_CLAUDE, 4002],
  [4004, LAUNCHER],
  [WRAPPED_CLAUDE, 4004],
])
const parentOf = (pid: number): number | undefined => parents.get(pid)
const env = { AGENT_CHAT_LAUNCHER_PID: String(LAUNCHER) }
const host = (hostPid: number) => ({ hostPid })

describe('whether a Claude Code process may use the spawn identity in its environment', () => {
  it('accepts the process run-agent launched', () => {
    expect(isLaunchedProcess(env, host(LAUNCHED_CLAUDE), parentOf)).toBe(true)
  })

  it('refuses a claude started from a shell inside the launched agent', () => {
    expect(isLaunchedProcess(env, host(NESTED_CLAUDE), parentOf)).toBe(false)
  })

  it('refuses a process whose grandparent, not parent, is the launcher', () => {
    expect(isLaunchedProcess(env, host(WRAPPED_CLAUDE), parentOf)).toBe(false)
  })

  it('refuses when the host process cannot be identified', () => {
    expect(isLaunchedProcess(env, {}, () => LAUNCHER)).toBe(false)
  })

  it('refuses when the host has no discoverable parent', () => {
    expect(isLaunchedProcess(env, host(9999), parentOf)).toBe(false)
  })

  it('trusts an agent from an older run-agent that stamps no launcher pid', () => {
    expect(isLaunchedProcess({}, host(NESTED_CLAUDE), parentOf)).toBe(true)
  })
})

describe('reading a parent pid when the launch carried no usable PATH', () => {
  const savedPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = savedPath
  })

  it('still finds this process’s parent with PATH lacking /bin and /usr/bin', () => {
    process.env.PATH = '/opt/homebrew/bin'

    expect(psParentOf(process.pid)).toBe(process.ppid)
  })

  it('still finds this process’s parent with an empty PATH', () => {
    process.env.PATH = ''

    expect(psParentOf(process.pid)).toBe(process.ppid)
  })
})

describe('the environment run-agent hands the launched process', () => {
  it('stamps its own pid over a launcher pid the plan tries to set', () => {
    const merged = launchEnv(
      { AGENT_CHAT_LAUNCHER_PID: '1', AGENT_CHAT_NAME: 'scout' },
      { HOME: '/h' },
      4242,
      [],
      LAUNCHER_PID_ENV,
    )

    expect(merged).toEqual({ HOME: '/h', AGENT_CHAT_NAME: 'scout', AGENT_CHAT_LAUNCHER_PID: '4242' })
  })

  it('deletes a variable the plan marks unset, even when the broker carried it (CC-200)', () => {
    const merged = launchEnv(
      {},
      { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude-profiles/broker' },
      4242,
      ['CLAUDE_CONFIG_DIR'],
      LAUNCHER_PID_ENV,
    )

    expect(merged).toEqual({ HOME: '/h', AGENT_CHAT_LAUNCHER_PID: '4242' })
  })
})
