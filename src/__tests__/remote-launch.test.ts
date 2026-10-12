import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProfile } from '../agents/profiles.js'
import type { AgentProfile, LaunchPlan } from '../agents/types.js'
import type { RemoteLaunch, SurfaceName } from '../protocol.js'
import { placeRemoteSpawn, prepareRemoteSpawn, type SpawnHost } from '../server/remote-launch.js'

/**
 * CC-1059 a: the half of a cross-host spawn that runs on the caller's host. The broker cannot see
 * this disk, so the cwd and account in the spec are checked here, and the env and MCP servers
 * come from this host's own profile file. The home and workspace are disposable tmp dirs; the
 * profile loader, file writer and surface are fakes.
 */

let root: string
let homeDir: string
let workspace: string
let account: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-remote-launch-')))
  homeDir = path.join(root, 'home')
  workspace = path.join(homeDir, 'projects', 'fantasy-football')
  account = path.join(homeDir, '.claude-profiles', 'ff')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(account, { recursive: true })
  process.env.AGENT_CHAT_HOME = path.join(root, 'agent-chat')
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(root, { recursive: true, force: true })
})

const spec = (over: Partial<RemoteLaunch> = {}): RemoteLaunch => ({
  agentId: 'abcd1234',
  sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'ff-planner',
  profile: {
    name: 'bd-planner',
    description: 'd',
    model: 'opus',
    allowedTools: [],
    isolation: 'none',
    surface: 'headless',
    promptPrelude: '',
  },
  brief: 'plan the draft',
  preamble: '',
  surface: 'iterm-tab',
  cwd: workspace,
  configDir: account,
  ...over,
})

const LOCAL_PROFILE: AgentProfile = {
  name: 'bd-planner',
  description: 'local copy',
  model: 'opus',
  allowedTools: [],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: '',
  env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '3600' },
  mcpServers: { 'active-work': { command: '/mac/bin/active-work' } },
}

function fakeHost(over: Partial<SpawnHost> = {}) {
  const written: Array<{ plan: LaunchPlan; mcpConfig: Record<string, unknown> }> = []
  const launched: Array<{ surface: SurfaceName; plan: LaunchPlan; anchor: string | undefined }> = []
  const host: SpawnHost = {
    cliEntry: '/mac/agent-chat/dist/cli.js',
    homeDir,
    loadProfile: () => LOCAL_PROFILE,
    writeFiles: (plan, mcpConfig) => void written.push({ plan, mcpConfig }),
    launch: async (surface, plan, anchor) => void launched.push({ surface, plan, anchor }),
    discard: () => undefined,
    ...over,
  }
  return { host, written, launched }
}

describe('checking a spawn spec on the host that launches it', () => {
  it('refuses a cwd missing on this disk and writes nothing', () => {
    const { host, written } = fakeHost()
    const gone = path.join(homeDir, 'projects', 'not-here')

    const prepared = prepareRemoteSpawn(spec({ cwd: gone }), host)

    expect(prepared).toMatchObject({ ok: false })
    expect(!prepared.ok && prepared.reason).toContain(gone)
    expect(written).toEqual([])
  })

  it('refuses a cwd whose symlink resolves into a credential directory', () => {
    const ssh = path.join(homeDir, '.ssh')
    fs.mkdirSync(ssh)
    const innocent = path.join(homeDir, 'projects', 'innocent')
    fs.symlinkSync(ssh, innocent)
    const { host, written } = fakeHost()

    const prepared = prepareRemoteSpawn(spec({ cwd: innocent }), host)

    expect(!prepared.ok && prepared.reason).toContain('.ssh')
    expect(written).toEqual([])
  })

  it('refuses a config dir outside this host’s home', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-outside-'))
    const { host, written } = fakeHost()

    const prepared = prepareRemoteSpawn(spec({ configDir: outside }), host)
    fs.rmSync(outside, { recursive: true, force: true })

    expect(!prepared.ok && prepared.reason).toContain('config_dir must be under your home directory')
    expect(written).toEqual([])
  })

  it('refuses a spec that names no account rather than guessing one', () => {
    const { configDir: _none, ...noAccount } = spec()
    const { host, written } = fakeHost()

    const prepared = prepareRemoteSpawn(noAccount, host)

    expect(!prepared.ok && prepared.reason).toContain('names no account')
    expect(written).toEqual([])
  })
})

describe('the profile name the broker sends', () => {
  /** A profile file outside the profiles dir, as a crafted .json in a cloned repo would be. */
  function plantOutside(): { profiles: string; escape: string } {
    const profiles = path.join(root, 'agent-chat', 'profiles')
    fs.mkdirSync(profiles, { recursive: true })
    const clone = path.join(homeDir, 'projects', 'clone')
    fs.mkdirSync(clone, { recursive: true })
    const evil = { ...LOCAL_PROFILE, name: 'evil', mcpServers: { x: { command: '/evil' } } }
    fs.writeFileSync(path.join(clone, 'evil.json'), JSON.stringify(evil))
    return { profiles, escape: path.relative(profiles, path.join(clone, 'evil')) }
  }

  it('never loads a file outside the profiles dir', () => {
    const { profiles, escape } = plantOutside()

    const loaded = loadProfile(escape, profiles)

    expect(loaded).toEqual({ error: `the profile name ${JSON.stringify(escape)} is not a plain name` })
  })

  it('refuses a spec whose profile name leaves the profiles dir, and writes nothing', () => {
    const { profiles, escape } = plantOutside()
    const { host, written } = fakeHost({ loadProfile: name => loadProfile(name, profiles) })

    const prepared = prepareRemoteSpawn(spec({ profile: { ...spec().profile, name: escape } }), host)

    expect(!prepared.ok && prepared.reason).toContain('is not a plain name')
    expect(written).toEqual([])
  })
})

describe('building a spawn on the host that launches it', () => {
  it('keys the account by its resolved path', () => {
    const { host, written } = fakeHost()
    const spelled = path.join(homeDir, 'projects', '..', '.claude-profiles', 'ff')

    prepareRemoteSpawn(spec({ configDir: spelled }), host)

    expect(written[0]?.plan.env.CLAUDE_CONFIG_DIR).toBe(account)
  })

  it("runs in the spec's cwd on the spec's account", () => {
    const { host, written } = fakeHost()

    const prepared = prepareRemoteSpawn(spec(), host)

    expect(prepared).toMatchObject({ ok: true, warnings: [] })
    expect(written[0]?.plan.cwd).toBe(workspace)
    expect(written[0]?.plan.env.CLAUDE_CONFIG_DIR).toBe(account)
  })

  it('runs with the account variable unset when the spec says so', () => {
    const { configDir: _none, ...rest } = spec()
    const { host, written } = fakeHost()

    prepareRemoteSpawn({ ...rest, configDirUnset: true }, host)

    expect(written[0]?.plan.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it("takes env and MCP servers from this host's profile file, never from the spec", () => {
    const hostile = spec({
      profile: { ...spec().profile, env: { PATH: '/evil' }, mcpServers: { x: { command: '/evil' } } },
    } as Partial<RemoteLaunch>)
    const { host, written } = fakeHost()

    prepareRemoteSpawn(hostile, host)

    expect(written[0]?.plan.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('3600')
    expect(JSON.stringify(written[0]?.mcpConfig)).toContain('/mac/bin/active-work')
    expect(JSON.stringify(written[0])).not.toContain('/evil')
  })

  it('warns, and runs without profile env, when this host has no such profile', () => {
    const { host, written } = fakeHost({ loadProfile: name => ({ error: `no profile named "${name}"` }) })

    const prepared = prepareRemoteSpawn(spec(), host)

    expect(prepared.ok && prepared.warnings[0]).toContain('without its profile')
    expect(written[0]?.plan.env).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
  })
})

describe('opening a prepared spawn', () => {
  it("opens the spec's surface beside its anchor", async () => {
    const { host, launched } = fakeHost()
    const plan = { agentId: 'abcd1234' } as LaunchPlan

    const failure = await placeRemoteSpawn(spec({ anchor: 'w0t0p0' }), plan, host)

    expect(failure).toBeUndefined()
    expect(launched).toEqual([{ surface: 'iterm-tab', plan, anchor: 'w0t0p0' }])
  })

  it('returns why the surface did not open', async () => {
    const { host } = fakeHost({
      launch: async () => {
        throw new Error('osascript: not authorised')
      },
    })

    const failure = await placeRemoteSpawn(spec(), { agentId: 'abcd1234' } as LaunchPlan, host)

    expect(failure).toBe('osascript: not authorised')
  })
})
