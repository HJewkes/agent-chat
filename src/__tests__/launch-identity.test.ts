import { describe, expect, it } from 'vitest'
import { withoutLaunchIdentity } from '../launch-identity.js'
import { reapOwnLaunch, type ProcessTable } from '../agents/orphan-reap.js'

describe('what a broker spawned by an agent carries', () => {
  it('drops the launch identity and keeps the rest of the environment', () => {
    const env = withoutLaunchIdentity({
      AGENT_CHAT_AGENT_ID: 'a1',
      AGENT_CHAT_NAME: 'worker',
      AGENT_CHAT_LAUNCHER_PID: '100',
      AGENT_CHAT_HOME: '/h',
      PATH: '/bin',
    })
    expect(env).toEqual({ AGENT_CHAT_HOME: '/h', PATH: '/bin' })
  })

  it('leaves a quoted, renamed child of such a broker unmatched by the reap', () => {
    const brokerChildEnv = withoutLaunchIdentity({
      AGENT_CHAT_AGENT_ID: 'a1',
      AGENT_CHAT_LAUNCHER_PID: '100',
    })
    const signals: number[] = []
    const table: ProcessTable = {
      pids: () => [900],
      environ: () => brokerChildEnv as Record<string, string>,
      command: () => "tmux: server (/tmp/tmux-1/default) 'run-agent'",
      parentOf: () => 1,
      isAlive: () => true,
      signal: pid => void signals.push(pid),
    }
    reapOwnLaunch('a1', 100, { table, log: () => undefined, sleepSync: () => undefined, platform: 'linux' })
    expect(signals).toEqual([])
  })
})
