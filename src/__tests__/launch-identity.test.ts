import { describe, expect, it } from 'vitest'
import {
  clearLaunchIdentity,
  clearLaunchTmpDirs,
  isLaunchTmpDir,
  withoutLaunchIdentity,
} from '../launch-identity.js'
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

  it('drops another launch’s private temp dir, which is per-launch like the identity (CC-901)', () => {
    const env = withoutLaunchIdentity({
      TMPDIR: '/tmp/ac-lead-123',
      TMP: '/tmp/ac-lead-123/',
      TEMP: '/tmp/ac-lead-123',
      PATH: '/bin',
    })
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('keeps a shared or custom temp dir, and a path that only resembles a launch dir', () => {
    const kept = { TMPDIR: '/tmp', TMP: '/home/example/.cache/rounds', TEMP: '/tmp/ac-lead-123/sub' }
    expect(withoutLaunchIdentity(kept)).toEqual(kept)
    expect(withoutLaunchIdentity({ TMPDIR: '/tmp/ac-../x-1' })).toEqual({ TMPDIR: '/tmp/ac-../x-1' })
  })

  it('recognises a launch dir under the on-disk root and nothing else under .cache (CC-1184)', () => {
    expect(isLaunchTmpDir('/home/example/.cache/agent-chat/tmp/ac-worker-4242')).toBe(true)
    expect(isLaunchTmpDir('/home/example/.cache/other/ac-worker-4242')).toBe(false)
    expect(isLaunchTmpDir('home/example/.cache/agent-chat/tmp/ac-worker-4242')).toBe(false)
    expect(isLaunchTmpDir('/home/example/.cache/agent-chat/tmp/ac-worker-4242/sub')).toBe(false)
  })

  it('strips the on-disk form from TMPDIR, TMP and TEMP', () => {
    const dir = '/home/example/.cache/agent-chat/tmp/ac-lead-123'
    const env: NodeJS.ProcessEnv = { TMPDIR: dir, TMP: `${dir}/`, TEMP: dir, PATH: '/bin' }
    clearLaunchTmpDirs(env)
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('recognises a launch harness dir and nothing below it (CC-1266)', () => {
    expect(isLaunchTmpDir('/home/example/.cache/agent-chat/harness/ac-worker-4242')).toBe(true)
    expect(isLaunchTmpDir('/home/example/.cache/agent-chat/harness/ac-worker-4242/sub')).toBe(false)
    expect(isLaunchTmpDir('/home/example/.cache/agent-chat/harnessX/ac-worker-4242')).toBe(false)
  })

  it('strips another launch’s CLAUDE_CODE_TMPDIR and keeps an operator one (CC-1266)', () => {
    const launch: NodeJS.ProcessEnv = {
      CLAUDE_CODE_TMPDIR: '/home/example/.cache/agent-chat/harness/ac-lead-123',
      PATH: '/bin',
    }
    const operator: NodeJS.ProcessEnv = { CLAUDE_CODE_TMPDIR: '/home/example/cc', PATH: '/bin' }

    clearLaunchTmpDirs(launch)
    clearLaunchTmpDirs(operator)

    expect(launch).toEqual({ PATH: '/bin' })
    expect(operator).toEqual({ CLAUDE_CODE_TMPDIR: '/home/example/cc', PATH: '/bin' })
  })

  it('clears both in place, as a broker started by hand does to its own environment', () => {
    const env: NodeJS.ProcessEnv = { AGENT_CHAT_AGENT_ID: 'a1', TMPDIR: '/tmp/ac-lead-123', PATH: '/bin' }
    clearLaunchIdentity(env)
    expect(env).toEqual({ PATH: '/bin' })
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
      sessionOf: () => 5,
      isAlive: () => true,
      signal: pid => void signals.push(pid),
    }
    reapOwnLaunch('a1', 100, {
      table,
      log: () => undefined,
      sleepSync: () => undefined,
      platform: 'linux',
      kill: true,
    })
    expect(signals).toEqual([])
  })
})
