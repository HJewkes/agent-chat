import { describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import type { AgentProfile, LaunchPlanInput } from '../agents/types.js'
import {
  argvFromProcCmdline,
  channelStatusFromArgv,
  hostChannelStatus,
  procArgv,
} from '../broker/host-channels.js'
import { Registry } from '../broker/registry.js'
import { spawnedIdentity } from '../server/index.js'
import { HOST_MODE_ENV, resolveInboxSpool } from '../server/inbox-spool.js'

/**
 * CC-1669 S1: a worker whose system prompt teaches `gh-write -- <gh args>` read as `no`
 * rather than `print`, because the `ps` line is space-joined and the `--` inside one
 * argument ended the option scan before `-p`. Each test names the mutation it catches.
 * Every name, id and pid is synthetic.
 */

const PROMPT = 'Post in one call: `agent-chat gh-write -- <gh args> --body-file -`, then report.'
const ARGV = [
  'claude',
  '--name',
  'worker-a',
  '--append-system-prompt',
  PROMPT,
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
]
const PS_LINE = ARGV.join(' ')
const CMDLINE = `${ARGV.join('\0')}\0`
const SPOOL_ENV = { AGENT_CHAT_INBOX_SPOOL: '1' }

describe('print mode from /proc/<pid>/cmdline', () => {
  it('keeps a prompt holding " -- " as one argument, so the host still reads as print', () => {
    // Catches: splitting the cmdline on whitespace instead of NUL.
    const argv = argvFromProcCmdline(CMDLINE)

    expect(argv).toEqual(ARGV)
    expect(channelStatusFromArgv(argv ?? [])).toBe('print')
  })

  it('reads the same argv as a ps line would hide print mode in', () => {
    expect(channelStatusFromArgv(PS_LINE.split(/\s+/))).toBe('no')
  })

  it('reports nothing for an empty cmdline, which a zombie or kernel thread has', () => {
    // Catches: returning [] for an unreadable argv, which reads as `no` instead of `unknown`.
    expect(argvFromProcCmdline('')).toBeUndefined()
  })

  it('reads /proc/<pid>/cmdline and treats a failed read as unreadable', () => {
    const files: string[] = []
    const found = procArgv(4242, file => (files.push(file), CMDLINE))
    const missing = procArgv(4242, () => {
      throw new Error('ENOENT')
    })

    expect(files).toEqual(['/proc/4242/cmdline'])
    expect(found).toEqual(ARGV)
    expect(missing).toBeUndefined()
  })

  it('still splits an injected reader on spaces, as every older caller expects', () => {
    expect(hostChannelStatus(4242, 'agent-chat', () => 'claude -p')).toBe('print')
  })
})

const profile: AgentProfile = {
  name: 'test',
  description: 'a profile',
  model: 'sonnet',
  allowedTools: ['Read'],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: PROMPT,
}

const input = (over: Partial<LaunchPlanInput> = {}): LaunchPlanInput => ({
  agentId: 'ag000001',
  sessionId: '00000000-0000-4000-8000-000000000001',
  name: 'worker-a',
  profile,
  brief: 'do the thing',
  cwd: '/repo',
  cwdHoldsUserSettings: false,
  adopted: false,
  mcpConfigPath: '/state/agents/ag000001/mcp.json',
  ...over,
})

describe('the launcher tells its child it runs in print mode', () => {
  it('sets the flag on a headless launch and not on a pane', () => {
    // Catches: setting it unconditionally, or keying it on something other than `-p`.
    const headless = buildLaunchPlan(input()).env
    const pane = buildLaunchPlan(input({ surface: 'tmux' })).env

    expect(headless[HOST_MODE_ENV]).toBe('print')
    expect(pane[HOST_MODE_ENV]).toBeUndefined()
  })
})

describe('the MCP server trusts the launcher over the ps line', () => {
  it('spools for a launched print host whose ps line hides -p', () => {
    // Catches: dropping the env check from resolveInboxSpool.
    const env = { ...SPOOL_ENV, [HOST_MODE_ENV]: 'print' }

    const dir = resolveInboxSpool({ agentId: 'agent-x', env, hostPid: 4242, read: () => PS_LINE })

    expect(dir).toBeDefined()
  })

  it('falls back to the argv for a launch that predates the flag', () => {
    const hidden = resolveInboxSpool({
      agentId: 'agent-x',
      env: SPOOL_ENV,
      hostPid: 4242,
      read: () => PS_LINE,
    })
    const plain = resolveInboxSpool({
      agentId: 'agent-x',
      env: SPOOL_ENV,
      hostPid: 4242,
      read: () => 'claude -p',
    })

    expect(hidden).toBeUndefined()
    expect(plain).toBeDefined()
  })

  it('declares print mode on the registration of a launched print host', () => {
    // Catches: never copying the flag into the spawned identity the register frame is built from.
    const base = { AGENT_CHAT_AGENT_ID: 'agent-x', AGENT_CHAT_NAME: 'worker-a' }

    expect(spawnedIdentity({ ...base, [HOST_MODE_ENV]: 'print' })?.hostMode).toBe('print')
    expect(spawnedIdentity(base)?.hostMode).toBeUndefined()
  })
})

describe('the broker prefers the declared host mode', () => {
  const register = (hostMode?: 'print') => {
    const registry = new Registry<object>(Date.now, () => 'no')
    registry.register(
      {},
      {
        name: 'worker-a',
        workingOn: 'testing',
        cwd: '/tmp',
        pid: 1,
        hostPid: 4242,
        inboxSpool: true,
        ...(hostMode === undefined ? {} : { hostMode }),
      },
    )
    return registry.printVerdict('worker-a')
  }

  it('queues for a host that declared print, whatever its argv read says', () => {
    // Catches: the registry ignoring `hostMode` and re-deriving from argv.
    expect(register('print')).toBe('queued')
  })

  it('keeps the argv verdict for an older host that sends no field', () => {
    expect(register()).toBeUndefined()
  })
})
