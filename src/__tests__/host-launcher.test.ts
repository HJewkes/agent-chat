import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LaunchPlan } from '../agents/types.js'
import type { ClientMessage, RemoteLaunch } from '../protocol.js'
import {
  answerLaunch,
  answerProbe,
  handleHostFrame,
  hostSurfaces,
  type LauncherDeps,
  type LauncherIdentity,
} from '../server/host-launcher.js'
import { hostLauncherJob } from '../cli/verbs/host.js'

/**
 * CC-951 g2: the machine side of a host launcher. The broker checked the spec's paths only
 * lexically, so the launcher resolves them on its own disk and launches with the spec's cwd and
 * account, never its own. The surface, the file writes and the superseded marker are fakes.
 */

const LINUX: LauncherIdentity = { host: 'basement', platform: 'linux', surfaces: ['headless', 'tmux-window'] }

let home: string
let cwd: string
let configDir: string

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-launcher-home-')))
  cwd = path.join(home, 'projects', 'repo')
  configDir = path.join(home, '.claude-profiles', 'personal')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })
})

afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const spec = (over: Partial<RemoteLaunch> = {}): RemoteLaunch => ({
  agentId: 'abcd1234',
  sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'cc27',
  profile: {
    name: 'inherited',
    description: 'd',
    model: '',
    allowedTools: [],
    isolation: 'none',
    surface: 'tmux-window',
    role: 'coordinator',
    promptPrelude: '',
  },
  brief: 'State at teleport',
  preamble: 'you are a continuation',
  surface: 'tmux-window',
  successorFirst: true,
  cwd,
  configDir,
  ...over,
})

function fakeDeps(launch: (plan: LaunchPlan) => Promise<void> = async () => undefined) {
  const launched: { surface: string; plan: LaunchPlan }[] = []
  const written: LaunchPlan[] = []
  const superseded: string[] = []
  const deps: LauncherDeps = {
    homeDir: home,
    cliEntry: '/opt/agent-chat/dist/cli/index.js',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/launcher/own/account' },
    writeFiles: plan => void written.push(plan),
    launch: async (surface, plan) => {
      launched.push({ surface, plan })
      await launch(plan)
    },
    markSuperseded: agentId => void superseded.push(agentId),
  }
  return { deps, launched, written, superseded }
}

describe('a host_launch spec', () => {
  it('with a bad agent id is refused and nothing is written or launched', async () => {
    const { deps, launched, written } = fakeDeps()

    const answer = await answerLaunch(spec({ agentId: '../../etc' }), LINUX, deps)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toMatch(/not an agent id/)
    expect(written).toEqual([])
    expect(launched).toEqual([])
  })

  it("launches with the spec's cwd and account, not the launcher's own", async () => {
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec(), LINUX, deps)

    expect(answer).toEqual({ ok: true })
    expect(launched).toHaveLength(1)
    expect(launched[0]?.surface).toBe('tmux-window')
    expect(launched[0]?.plan.cwd).toBe(cwd)
    expect(launched[0]?.plan.cwd).not.toBe(process.cwd())
    expect(launched[0]?.plan.env.CLAUDE_CONFIG_DIR).toBe(configDir)
  })

  it('resolves a symlinked cwd that leads into a credential directory, and refuses it', async () => {
    const ssh = path.join(home, '.ssh')
    fs.mkdirSync(ssh)
    const link = path.join(home, 'projects', 'innocent')
    fs.symlinkSync(ssh, link)
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec({ cwd: link }), LINUX, deps)

    expect(answer.reason).toMatch(/protected directory \("\.ssh"\)/)
    expect(launched).toEqual([])
  })

  it('refuses a config dir that resolves outside the home directory', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-outside-')))
    const link = path.join(home, 'account')
    fs.symlinkSync(outside, link)
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec({ configDir: link }), LINUX, deps)

    fs.rmSync(outside, { recursive: true, force: true })
    expect(answer.reason).toMatch(/config dir .* outside the home directory/)
    expect(launched).toEqual([])
  })

  it('refuses an iTerm2 surface on linux before writing anything', async () => {
    const { deps, written } = fakeDeps()

    const answer = await answerLaunch(spec({ surface: 'iterm-window' }), LINUX, deps)

    expect(answer.reason).toMatch(/cannot open a iterm-window surface/)
    expect(written).toEqual([])
  })

  it('that outruns its budget is refused and its successor marked superseded', async () => {
    const { deps, superseded } = fakeDeps(() => new Promise(() => undefined))

    const answer = await answerLaunch(spec(), LINUX, deps, 20)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toMatch(/did not open within/)
    expect(superseded).toEqual(['abcd1234'])
  })
})

describe('a host_probe', () => {
  it('passes when the cwd and config dir exist under home', () => {
    const { deps } = fakeDeps()

    expect(answerProbe({ cwd, configDir, surface: 'tmux-window' }, LINUX, deps)).toEqual({ ok: true })
  })

  it('names the missing cwd', () => {
    const { deps } = fakeDeps()
    const missing = path.join(home, 'projects', 'gone')

    const answer = answerProbe({ cwd: missing, surface: 'headless' }, LINUX, deps)

    expect(answer).toEqual({ ok: false, reason: `its cwd ${missing} is not a directory on this machine` })
  })
})

describe('handleHostFrame', () => {
  it('answers a probe on the link with the same id', async () => {
    const { deps } = fakeDeps()
    const sent: ClientMessage[] = []
    const link = { send: (frame: ClientMessage) => void sent.push(frame), isOpen: () => true }

    await handleHostFrame(
      { t: 'host_probe', id: 'p1', probe: { cwd, surface: 'headless' } },
      LINUX,
      deps,
      link,
    )

    expect(sent).toEqual([{ t: 'host_probe_result', id: 'p1', ok: true }])
  })

  it('marks a launched successor superseded when its answer can no longer reach the broker', async () => {
    const { deps, superseded, launched } = fakeDeps()
    const sent: ClientMessage[] = []
    const link = { send: (frame: ClientMessage) => void sent.push(frame), isOpen: () => false }

    await handleHostFrame({ t: 'host_launch', id: 'l1', launch: spec() }, LINUX, deps, link)

    expect(launched).toHaveLength(1)
    expect(superseded).toEqual(['abcd1234'])
    expect(sent).toEqual([])
  })
})

describe('host surfaces and install', () => {
  it('offers iTerm2 only on macOS and tmux only where it is installed', () => {
    expect(hostSurfaces('linux', true)).toEqual(['headless', 'tmux-window'])
    expect(hostSurfaces('linux', false)).toEqual(['headless'])
    expect(hostSurfaces('darwin', false)).toEqual(['headless', 'iterm-pane', 'iterm-tab', 'iterm-window'])
  })

  it('keeps `host serve` alive under the announced name', () => {
    const job = hostLauncherJob({ nodePath: '/n', cliEntry: '/c.js', logDir: '/l', env: {}, host: 'mac' })

    expect(job.args).toEqual(['/n', '/c.js', 'host', 'serve', '--host', 'mac'])
    expect(job.schedule.kind).toBe('keep-alive')
  })
})
