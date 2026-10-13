import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { ProfileBaseline, type ProfileDriftMode } from '../agents/profile-baseline.js'
import type { SpawnOutcome } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/** CC-1094: a profile file rewritten after broker start is flagged, or refused, on an agent spawn. */

const tmpDirs: string[] = []
let home: string
let core: BrokerCore
let sup: Supervisor
let launches: number
let mode: ProfileDriftMode
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

const spawn = (name: string, profile: string, requestedBy: string): Promise<SpawnOutcome> =>
  sup.spawn({
    name,
    profile,
    brief: 'do the task',
    requestedBy,
    cwd: tmp('drift-cwd-'),
    surface: 'headless',
    spawnerConfigDir: tmp('drift-account-'),
  })

const driftWarnings = (outcome: SpawnOutcome): string[] =>
  (outcome.warnings ?? []).filter(warning => warning.includes('after the broker started'))

beforeEach(() => {
  home = tmp('drift-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('bd-implementer')
  writeProfile('steady')
  launches = 0
  mode = 'flag'
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    cwdLister: async () => [],
    profileBaseline: new ProfileBaseline(path.join(home, 'profiles')),
    profileDriftMode: () => mode,
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

describe('profile drift at spawn (CC-1094)', () => {
  it('spawns an unchanged profile with no drift warning', async () => {
    const outcome = await spawn('worker-a', 'steady', 'titan-coord')

    expect(outcome.ok).toBe(true)
    expect(driftWarnings(outcome)).toEqual([])
  })

  it('flags an agent spawn of a profile rewritten after start, naming the file', async () => {
    writeProfile('bd-implementer', 'rewritten')

    const outcome = await spawn('worker-b', 'bd-implementer', 'titan-coord')

    expect(outcome.ok).toBe(true)
    expect(driftWarnings(outcome)).toEqual([expect.stringContaining(profileFile('bd-implementer'))])
  })

  it('catches a rewrite that restores the old mtime', async () => {
    const { atime, mtime } = fs.statSync(profileFile('bd-implementer'))
    writeProfile('bd-implementer', 'rewritten')
    fs.utimesSync(profileFile('bd-implementer'), atime, mtime)

    const outcome = await spawn('worker-c', 'bd-implementer', 'titan-coord')

    expect(driftWarnings(outcome)).toHaveLength(1)
  })

  it('refuses an agent spawn of a drifted profile under refuse, launching nothing', async () => {
    mode = 'refuse'
    writeProfile('bd-implementer', 'rewritten')

    const outcome = await spawn('worker-d', 'bd-implementer', 'titan-coord')

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain(profileFile('bd-implementer'))
    expect(launches).toBe(0)
  })

  it('lets a human spawn a drifted profile under refuse and re-baselines it', async () => {
    mode = 'refuse'
    writeProfile('bd-implementer', 'rewritten')

    const human = await spawn('worker-e', 'bd-implementer', 'human')
    const after = await spawn('worker-f', 'bd-implementer', 'titan-coord')

    expect(human.ok).toBe(true)
    expect(after.ok).toBe(true)
    expect(driftWarnings(after)).toEqual([])
  })

  it('counts a profile file created after start as drift', async () => {
    mode = 'refuse'
    writeProfile('newcomer')

    const outcome = await spawn('worker-g', 'newcomer', 'titan-coord')

    expect(outcome.reason).toContain('was created after the broker started')
  })

  it('never counts a builtin with no file as drift', async () => {
    mode = 'refuse'

    const outcome = await spawn('worker-h', 'explorer', 'titan-coord')

    expect(outcome.ok).toBe(true)
    expect(driftWarnings(outcome)).toEqual([])
  })
})
