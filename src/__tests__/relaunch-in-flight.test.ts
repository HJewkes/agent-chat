import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1457: a surface switch and a `resume_session` spawn relaunched a session
 * without the in-flight guard CC-1456 gave resume, so either could start a second
 * process on a session another launch was still starting.
 */

type Launch = (...args: unknown[]) => Promise<unknown>

const SEAT_SESSION = '6f1c2a4e-3b5d-4c7e-8f90-1a2b3c4d5e6f'
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER_SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ISO = '\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z'

const tmpDirs: string[] = []
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const stateOf = (agentId: string): string | undefined =>
  core.agents.roster({ includeRetired: true }).find(a => a.agentId === agentId)?.state

/** A headless seat-x that exited with its transcript on disk, so it is resumable and surfaceable. */
async function exitedSeat(): Promise<void> {
  const cwd = tmp('relaunch-cwd-')
  const meta = { cwd, profile: 'explorer', isolation: 'none', surface: 'headless', session_id: SEAT_SESSION }
  core.append({ kind: 'agent_spawned', actor: 'scout', target: 'seat-x', msgId: 'agent', body: 'work', meta })
  await vi.waitFor(() => expect(stateOf('agent')).toBe('live'))
  // A row, not `recordExit`: the supervisor never launched this seat, so `recordExit` would find no entry and write nothing.
  core.append({ kind: 'agent_exited', actor: 'seat-x', ref: 'agent', meta: { code: '0' } })
  expect(stateOf('agent')).toBe('exited')
  writeTranscript(cwd, SEAT_SESSION)
}

function writeTranscript(cwd: string, session: string, account?: string): void {
  const file = transcriptPath(cwd, session, account)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

/** Holds launches until `open`; later launches pass straight through. */
function slowLauncher(): { launches: () => number; open: () => void } {
  const target = sup as unknown as { launchOn: Launch }
  const real = target.launchOn.bind(sup)
  let count = 0
  let release: () => void = () => undefined
  let gate = new Promise<void>(resolve => (release = resolve))
  target.launchOn = async (...args) => {
    count += 1
    await gate
    gate = Promise.resolve()
    return real(...args)
  }
  return { launches: () => count, open: () => release() }
}

async function recordExit(): Promise<void> {
  const exit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await exit.call(sup, 'agent', { code: 0, signal: null })
}

const surface = () => sup.switchSurface({ name: 'seat-x', to: 'interactive', requestedBy: 'human' })

/** A seat respawn's shape: a new name on a session whose transcript is under `cwd` and `account`. */
function sessionSpawner(): (name: string, session: string) => ReturnType<Supervisor['spawn']> {
  const cwd = tmp('relaunch-spawn-cwd-')
  const account = tmp('relaunch-account-')
  for (const id of [SESSION, OTHER_SESSION]) writeTranscript(cwd, id, account)
  return (name, session) =>
    sup.spawn({
      name,
      profile: 'explorer',
      brief: 'carry on',
      requestedBy: 'human',
      cwd,
      isolation: 'none',
      surface: 'headless',
      spawnerConfigDir: account,
      resumeSession: session,
    })
}

beforeEach(() => {
  const home = tmp('relaunch-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    nameFreeMs: 50,
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid'),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a surface switch and a resume on one agent', () => {
  it('refuses a surface switch while a resume is launching, and switches once it has answered', async () => {
    await exitedSeat()
    const launcher = slowLauncher()
    const resuming = sup.resume('seat-x')
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))

    const surfacing = surface()
    launcher.open()
    const [refused, resumed] = await Promise.all([surfacing, resuming])
    await recordExit()
    const later = await surface()

    expect(refused).toMatchObject({ ok: false })
    expect(refused.reason).toMatch(new RegExp(`^seat-x is already resuming \\(since ${ISO}\\)`))
    expect(resumed).toMatchObject({ ok: true, agentId: 'agent' })
    expect(later).toMatchObject({ ok: true, agentId: 'agent' })
    expect(launcher.launches()).toBe(2)
  })

  it('refuses a resume while a surface switch is launching, and resumes once it has answered', async () => {
    await exitedSeat()
    const launcher = slowLauncher()
    const switching = surface()
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))

    const resumeRetry = sup.resume('seat-x')
    launcher.open()
    const [refused, switched] = await Promise.all([resumeRetry, switching])
    await recordExit()
    const later = await sup.resume('seat-x')

    expect(refused).toMatchObject({ ok: false })
    expect(refused.reason).toMatch(new RegExp(`^seat-x is already resuming \\(since ${ISO}\\)`))
    expect(switched).toMatchObject({ ok: true, agentId: 'agent' })
    expect(later).toMatchObject({ ok: true, agentId: 'agent' })
    expect(launcher.launches()).toBe(2)
  })
})

describe('two resume_session spawns on one session', () => {
  it('refuses the second while the first is launching, and launches once it has answered', async () => {
    const spawnOn = sessionSpawner()
    const launcher = slowLauncher()
    const first = spawnOn('seat-x', SESSION)
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))

    const second = spawnOn('seat-y', SESSION)
    launcher.open()
    const [refused, spawned] = await Promise.all([second, first])
    const later = await spawnOn('seat-z', SESSION)

    expect(refused).toMatchObject({ ok: false })
    expect(refused.reason).toMatch(
      new RegExp(`^session ${SESSION} is already launching for seat-x \\(since ${ISO}\\)`),
    )
    expect(spawned).toMatchObject({ ok: true })
    expect(later).toMatchObject({ ok: true })
    expect(launcher.launches()).toBe(2)
  })

  it('does not hold a spawn on a different session', async () => {
    const spawnOn = sessionSpawner()
    const launcher = slowLauncher()
    const first = spawnOn('seat-x', SESSION)
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))

    const other = spawnOn('seat-y', OTHER_SESSION)
    await vi.waitFor(() => expect(launcher.launches()).toBe(2))
    launcher.open()

    expect(await Promise.all([first, other])).toMatchObject([{ ok: true }, { ok: true }])
  })

  it('refuses a resume_session spawn on the session a resume is launching', async () => {
    await exitedSeat()
    const spawnOn = sessionSpawner()
    const launcher = slowLauncher()
    const resuming = sup.resume('seat-x')
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))

    const spawning = spawnOn('seat-y', SEAT_SESSION)
    launcher.open()
    const [refused, resumed] = await Promise.all([spawning, resuming])

    expect(refused.reason).toMatch(new RegExp(`^session ${SEAT_SESSION} is already launching for seat-x`))
    expect(resumed).toMatchObject({ ok: true })
    expect(launcher.launches()).toBe(1)
  })
})
