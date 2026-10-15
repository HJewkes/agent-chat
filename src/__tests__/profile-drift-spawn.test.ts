import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SpawnOutcome, type SpawnRequest } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import { ProfileBaseline, type ProfileDriftMode } from '../agents/profile-baseline.js'
import { autoAttach } from './broker-harness.js'

/** CC-1094: a profile file rewritten after broker start is flagged, or refused, on an agent spawn. */

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

const profileFile = (name: string): string => path.join(home, 'profiles', `${name}.json`)

function writeProfile(name: string, description = name): void {
  fs.writeFileSync(
    profileFile(name),
    JSON.stringify({
      description,
      model: 'sonnet',
      allowedTools: ['Read'],
      isolation: 'none',
      surface: 'headless',
    }),
  )
}

const spawn = (
  name: string,
  profile: string,
  requestedBy: string,
  over: Partial<SpawnRequest> = {},
): Promise<SpawnOutcome> =>
  sup.spawn({
    name,
    profile,
    brief: 'do the task',
    requestedBy,
    cwd: tmp('drift-cwd-'),
    surface: 'headless',
    spawnerConfigDir: tmp('drift-account-'),
    ...over,
  })

async function exited(outcome: SpawnOutcome): Promise<void> {
  const agent = core.agents.get(outcome.agentId as string)!
  const transcript = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, '{}\n')
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

const driftWarnings = (outcome: SpawnOutcome): string[] =>
  (outcome.warnings ?? []).filter(warning => warning.includes('after the broker started'))

function start(mode?: ProfileDriftMode): void {
  sup?.close()
  sup = new Supervisor(core, {
    cwdLister: async () => [],
    profileBaseline: new ProfileBaseline(path.join(home, 'profiles')),
    ...(mode === undefined ? {} : { profileDriftMode: mode }),
    surface: {
      platform: 'darwin',
      spawn: () => {
        launches++
        return { pid: 4242, unref: () => undefined, once: () => undefined }
      },
    },
  })
}

const writeConfig = (profileDrift: ProfileDriftMode): void =>
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profileDrift }))

beforeEach(() => {
  home = tmp('drift-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('bd-implementer')
  writeProfile('steady')
  launches = 0
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  start('flag')
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('profile drift at spawn (CC-1094)', () => {
  it('spawns an unchanged profile with no drift warning', async () => {
    const outcome = await spawn('worker-a', 'steady', 'seat-a')

    expect(outcome.ok).toBe(true)
    expect(driftWarnings(outcome)).toEqual([])
  })

  it('flags an agent spawn of a profile rewritten after start, naming the file', async () => {
    writeProfile('bd-implementer', 'rewritten')

    const outcome = await spawn('worker-b', 'bd-implementer', 'seat-a')

    expect(outcome.ok).toBe(true)
    expect(driftWarnings(outcome)).toEqual([expect.stringContaining(profileFile('bd-implementer'))])
  })

  it('catches a rewrite that restores the old mtime', async () => {
    const { atime, mtime } = fs.statSync(profileFile('bd-implementer'))
    writeProfile('bd-implementer', 'rewritten')
    fs.utimesSync(profileFile('bd-implementer'), atime, mtime)

    const outcome = await spawn('worker-c', 'bd-implementer', 'seat-a')

    expect(driftWarnings(outcome)).toHaveLength(1)
  })

  it('refuses an agent spawn of a drifted profile under refuse, launching nothing', async () => {
    start('refuse')
    writeProfile('bd-implementer', 'rewritten')

    const outcome = await spawn('worker-d', 'bd-implementer', 'seat-a')

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain(profileFile('bd-implementer'))
    expect(launches).toBe(0)
  })

  it('lets a human spawn a drifted profile under refuse and re-baselines it', async () => {
    start('refuse')
    writeProfile('bd-implementer', 'rewritten')

    const human = await spawn('worker-e', 'bd-implementer', 'human')
    const after = await spawn('worker-f', 'bd-implementer', 'seat-a')

    expect(human.ok).toBe(true)
    expect(after.ok).toBe(true)
    expect(driftWarnings(after)).toEqual([])
  })

  it('refuses a burndown spawn of a drifted profile under refuse and keeps the old baseline', async () => {
    start('refuse')
    writeProfile('bd-implementer', 'rewritten')

    const burndown = await spawn('worker-i', 'bd-implementer', 'human', {
      spawnedAs: 'burndown',
      task: 'claude-channels/CC-1094',
    })
    const after = await spawn('worker-j', 'bd-implementer', 'seat-a')

    expect(burndown.ok).toBe(false)
    expect(burndown.reason).toContain(profileFile('bd-implementer'))
    expect(after.ok).toBe(false)
    expect(launches).toBe(0)
  })

  it('refuses a human resume of an agent whose profile was rewritten under refuse', async () => {
    start('refuse')
    const first = await spawn('worker-k', 'bd-implementer', 'seat-a')
    await exited(first)
    writeProfile('bd-implementer', 'rewritten')

    const resumed = await sup.resume('worker-k', { requestedBy: 'human' })

    expect(resumed.ok).toBe(false)
    expect(resumed.reason).toContain(profileFile('bd-implementer'))
  })

  it('counts a profile file created after start as drift', async () => {
    start('refuse')
    writeProfile('newcomer')

    const outcome = await spawn('worker-g', 'newcomer', 'seat-a')

    expect(outcome.reason).toContain('was created after the broker started')
  })

  it('never counts a builtin with no file as drift', async () => {
    start('refuse')

    const outcome = await spawn('worker-h', 'explorer', 'seat-a')

    expect(outcome.ok).toBe(true)
    expect(driftWarnings(outcome)).toEqual([])
  })

  it('refuses, without throwing, a spawn whose profile path is a directory', async () => {
    fs.mkdirSync(profileFile('hollow'))

    const outcome = await spawn('worker-l', 'hollow', 'seat-a')

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain(`cannot read ${profileFile('hollow')}`)
  })

  it.skipIf(process.getuid?.() === 0)(
    'refuses, without throwing, a spawn whose profile is unreadable',
    async () => {
      writeProfile('sealed')
      fs.chmodSync(profileFile('sealed'), 0o000)

      const outcome = await spawn('worker-m', 'sealed', 'seat-a')

      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toContain(`cannot read ${profileFile('sealed')}`)
    },
  )

  it('keeps refusing after config.json is loosened to flag post-start (CC-1202)', async () => {
    writeConfig('refuse')
    start()
    writeConfig('flag')
    writeProfile('bd-implementer', 'rewritten')

    const outcome = await spawn('worker-n', 'bd-implementer', 'seat-a')

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain(profileFile('bd-implementer'))
    expect(launches).toBe(0)
  })

  it('keeps flagging after config.json is tightened to refuse post-start (CC-1202)', async () => {
    writeConfig('flag')
    start()
    writeConfig('refuse')
    writeProfile('bd-implementer', 'rewritten')

    const outcome = await spawn('worker-o', 'bd-implementer', 'seat-a')

    expect(outcome.ok).toBe(true)
    expect(driftWarnings(outcome)).toHaveLength(1)
  })
})
