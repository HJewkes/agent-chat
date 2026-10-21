import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SpawnOutcome } from '../agents/supervisor.js'
import { BUILTIN_PROFILES, harnessRefusal, parseProfile } from '../agents/profiles.js'
import { agentProfiles } from '../server/commands/agent-profiles.js'
import { autoAttach } from './broker-harness.js'

/** CC-1516: `harness` defaults to claude-code, and a codex profile refuses every launch until CC-1517. */

const base = { model: 'gpt-5-codex', allowedTools: ['Read'], isolation: 'none', surface: 'headless' }

describe('profile harness field (CC-1516)', () => {
  it('leaves a profile without the field unchanged and launchable', () => {
    const profile = parseProfile('plain', { ...base, model: 'sonnet' })

    expect(profile).not.toHaveProperty('harness')
    expect(harnessRefusal(profile as never)).toBeUndefined()
  })

  it('keeps an explicit claude-code harness and launches it', () => {
    const profile = parseProfile('explicit', { ...base, model: 'opus', harness: 'claude-code' })

    expect(profile).toMatchObject({ harness: 'claude-code' })
    expect(harnessRefusal(profile as never)).toBeUndefined()
  })

  it('refuses an unknown harness at load, naming the allowed values', () => {
    const profile = parseProfile('odd', { ...base, harness: 'gemini' })

    expect(profile).toEqual({ error: 'odd: "harness" must be one of claude-code, codex' })
  })

  it.each(['opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'claude-sonnet-5-5', 'Claude-Opus-5-5'])(
    'refuses the Claude model %s on a codex profile',
    model => {
      const profile = parseProfile('mixed', { ...base, harness: 'codex', model })

      expect(profile).toEqual({ error: expect.stringContaining('is a Claude model') })
    },
  )

  it('loads a codex profile but names the capability it waits on', () => {
    const profile = parseProfile('codex-worker', { ...base, harness: 'codex' })

    expect(profile).toMatchObject({ harness: 'codex', model: 'gpt-5-codex' })
    expect(harnessRefusal(profile as never)).toBe(
      'harness_unsupported: profile "codex-worker" uses harness "codex", unsupported until the Codex launch plan (CC-1517)',
    )
  })

  it('gives no builtin a harness, so their launch plans are as before', () => {
    expect(BUILTIN_PROFILES.filter(p => 'harness' in p)).toEqual([])
  })
})

describe('spawning a codex profile (CC-1516)', () => {
  const tmpDirs: string[] = []
  let home: string
  let core: BrokerCore
  let sup: Supervisor
  let launches: number
  let stopAutoAttach: () => void

  const tmp = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
    tmpDirs.push(dir)
    return dir
  }

  const writeProfile = (name: string, body: Record<string, unknown>): void =>
    fs.writeFileSync(path.join(home, 'profiles', `${name}.json`), JSON.stringify(body))

  const spawn = (name: string, profile: string): Promise<SpawnOutcome> =>
    sup.spawn({
      name,
      profile,
      brief: 'do the task',
      requestedBy: 'seat-a',
      cwd: tmp('harness-cwd-'),
      surface: 'headless',
      spawnerConfigDir: tmp('harness-account-'),
    })

  beforeEach(() => {
    home = tmp('harness-home-')
    process.env.AGENT_CHAT_HOME = home
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
    writeProfile('codex-worker', { ...base, harness: 'codex', isolation: 'worktree' })
    writeProfile('claude-worker', { ...base, model: 'sonnet', harness: 'claude-code' })
    launches = 0
    const events = new EventLog(path.join(home, 'events.db'))
    core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
    stopAutoAttach = autoAttach(core)
    sup = new Supervisor(core, {
      cwdLister: async () => [],
      surface: {
        platform: 'darwin',
        spawn: () => {
          launches++
          return { pid: 4242, unref: () => undefined, once: () => undefined }
        },
      },
    })
  })

  afterEach(() => {
    stopAutoAttach()
    sup.close()
    delete process.env.AGENT_CHAT_HOME
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses with a typed reason before any process, worktree or slot exists', async () => {
    const outcome = await spawn('worker-a', 'codex-worker')

    expect(outcome).toMatchObject({
      ok: false,
      code: 'harness_unsupported',
      retryable: false,
      reason: expect.stringContaining('unsupported until the Codex launch plan'),
    })
    expect(launches).toBe(0)
    expect(core.agents.roster()).toEqual([])
  })

  it('still spawns a profile that names claude-code', async () => {
    const outcome = await spawn('worker-b', 'claude-worker')

    expect(outcome.ok).toBe(true)
    expect(launches).toBe(1)
  })

  it('shows each profile harness in agent_profiles', async () => {
    const out = String(await agentProfiles.run({} as never, {} as never))

    expect(out).toMatch(/- codex-worker \[worker, gpt-5-codex, headless, isolation worktree, harness codex\]/)
    expect(out).toMatch(/- reviewer \[[^\]]*, harness claude-code\]/)
  })
})
