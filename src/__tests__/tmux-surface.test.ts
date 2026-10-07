import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { resolveSurface } from '../agents/surface-resolution.js'
import { resolveTmuxOnLinux } from '../config.js'
import { loadProfile } from '../agents/profiles.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { SURFACE_NAMES } from '../protocol.js'
import { transcriptPath } from '../agents/transcript.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-804: the tmux-window surface and the Linux override. tmux is a stand-in script on PATH that
 * logs its argv and answers like a server holding one window, so no test ever reaches a real tmux.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void
let tmuxLog: string
const originalPath = process.env.PATH

const tmpDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function installFakeTmux(): string {
  const bin = tmpDir('agent-chat-faketmux-')
  const log = path.join(bin, 'calls.log')
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in\n  new-window|new-session) echo "@7" ;;\n  list-windows) echo "@7" ;;\nesac\nexit 0\n`,
    { mode: 0o755 },
  )
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  return log
}

const tmuxCalls = (): string[] =>
  fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').filter(Boolean) : []

const enableOverride = (): void => {
  fs.writeFileSync(
    path.join(process.env.AGENT_CHAT_HOME as string, 'config.json'),
    '{"tmuxSurfaceOnLinux":true}',
  )
}

const spawnReq = (over: Record<string, unknown> = {}) => ({
  name: 'seat',
  profile: 'explorer',
  brief: 'read the log',
  requestedBy: 'human',
  cwd: tmpDir('agent-chat-ws-'),
  isolation: 'none' as const,
  surface: 'iterm-window' as const,
  ...over,
})

beforeEach(() => {
  const dir = tmpDir('agent-chat-tmux-')
  process.env.AGENT_CHAT_HOME = dir
  const events = new EventLog(path.join(dir, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  tmuxLog = installFakeTmux()
  supervisor = new Supervisor(core, { surface: { platform: 'linux' } })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  process.env.PATH = originalPath
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('surface resolution', () => {
  it.each(['iterm-pane', 'iterm-tab', 'iterm-window'] as const)(
    'maps %s to tmux-window on an opted-in linux host',
    name => {
      expect(resolveSurface(name, 'linux', true)).toBe('tmux-window')
    },
  )

  it.each(SURFACE_NAMES)('leaves %s alone on darwin even when opted in', name => {
    expect(resolveSurface(name, 'darwin', true)).toBe(name)
  })

  it('keeps headless and tmux-window as they are on linux', () => {
    expect(resolveSurface('headless', 'linux', true)).toBe('headless')
    expect(resolveSurface('tmux-window', 'linux', true)).toBe('tmux-window')
  })

  it('leaves iTerm names alone on a linux host that has not opted in', () => {
    expect(resolveSurface('iterm-window', 'linux', false)).toBe('iterm-window')
  })

  it('reads the opt-in from config.json and defaults to off', () => {
    expect(resolveTmuxOnLinux()).toBe(false)
    enableOverride()
    expect(resolveTmuxOnLinux()).toBe(true)
  })
})

describe('the tmux-window surface', () => {
  it('is a surface name and a valid profile surface', () => {
    expect(SURFACE_NAMES).toContain('tmux-window')
    const dir = tmpDir('agent-chat-profiles-')
    fs.writeFileSync(
      path.join(dir, 'seat.json'),
      JSON.stringify({ model: 'opus', allowedTools: [], isolation: 'none', surface: 'tmux-window' }),
    )
    expect(loadProfile('seat', dir)).toMatchObject({ surface: 'tmux-window' })
  })

  it('spawns an iterm-window request into a tmux window on an opted-in linux host', async () => {
    enableOverride()
    const result = await supervisor.spawn(spawnReq())

    expect(result.ok).toBe(true)
    expect(core.agents.get(result.agentId!)?.surface).toBe('tmux-window')
    expect(tmuxCalls().some(call => call.startsWith('new-session') || call.startsWith('new-window'))).toBe(
      true,
    )
    expect(tmuxCalls().join('\n')).toContain('run-agent')
  })

  it('refuses an iterm-window request on linux when not opted in, and never calls tmux', async () => {
    const result = await supervisor.spawn(spawnReq())

    expect(result.ok).toBe(false)
    expect(tmuxCalls()).toEqual([])
  })

  it('closes the window of an agent that exited, then resumes it into a new one', async () => {
    supervisor.close()
    supervisor = new Supervisor(core, { surface: { platform: 'linux' }, settleMs: 20 })
    const first = await supervisor.spawn(spawnReq({ surface: 'tmux-window' }))
    const agent = core.agents.get(first.agentId!)!
    const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')

    core.append({ kind: 'agent_detached', actor: 'seat', ref: agent.agentId })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(tmuxCalls().some(call => call.startsWith('kill-window -t @7'))).toBe(true)

    const resumed = await supervisor.resume('seat', { surface: 'tmux-window' })

    expect(resumed.reason ?? '').toBe('')
    expect(tmuxCalls().filter(call => call.startsWith('new-'))).toHaveLength(2)
  })

  it('passes --remote-control to a tmux-window launch', () => {
    const profile = loadProfile('explorer')
    if ('error' in profile) throw new Error(profile.error)
    const plan = buildLaunchPlan({
      agentId: 'a1',
      sessionId: 's1',
      name: 'seat',
      profile,
      brief: 'go',
      cwd: '/tmp',
      surface: 'tmux-window',
      remoteControl: true,
      mcpConfigPath: '/tmp/mcp.json',
      hookSettingsPath: '/tmp/hooks.json',
    })

    expect(plan.args).toContain('--remote-control')
  })
})
