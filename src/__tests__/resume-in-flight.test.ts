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
 * CC-1456: a caller whose resume timed out retried it while the first was still
 * launching, and the second saw the old `exited` state and launched again: two
 * processes on one session.
 */

type Launch = (...args: unknown[]) => Promise<unknown>

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

/** A headless seat-x that exited with its transcript on disk, so it is resumable. */
async function exitedSeat(): Promise<void> {
  const cwd = tmp('in-flight-cwd-')
  const meta = { cwd, profile: 'explorer', isolation: 'none', surface: 'headless', session_id: 'sess-own' }
  core.append({ kind: 'agent_spawned', actor: 'scout', target: 'seat-x', msgId: 'agent', body: 'work', meta })
  await vi.waitFor(() => expect(stateOf('agent')).toBe('live'))
  core.append({ kind: 'agent_exited', actor: 'seat-x', ref: 'agent', meta: { code: '0' } })
  const file = transcriptPath(cwd, 'sess-own')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

/** Holds launches until `open`, which fails the held ones with `failure`; later launches pass straight through. */
function slowLauncher(): { launches: () => number; open: (failure?: Error) => void } {
  const target = sup as unknown as { launchOn: Launch }
  const real = target.launchOn.bind(sup)
  let count = 0
  let release: (failure?: Error) => void = () => undefined
  let gate = new Promise<Error | undefined>(resolve => (release = resolve))
  target.launchOn = async (...args) => {
    count += 1
    const failure = await gate
    gate = Promise.resolve(undefined)
    if (failure) throw failure
    return real(...args)
  }
  return { launches: () => count, open: failure => release(failure) }
}

async function recordExit(): Promise<void> {
  const exit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await exit.call(sup, 'agent', { code: 0, signal: null })
}

beforeEach(() => {
  const home = tmp('in-flight-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    surface: { platform: 'linux', spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }) },
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a resume retried while the first is still launching', () => {
  it('launches once and refuses the retry as already resuming', async () => {
    await exitedSeat()
    const launcher = slowLauncher()

    const first = sup.resume('seat-x')
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))
    const retry = await sup.resume('seat-x')
    launcher.open()

    expect(retry).toMatchObject({ ok: false })
    expect(retry.reason).toMatch(/^seat-x is already resuming \(since \d{4}-\d\d-\d\dT[\d:.]+Z\)/)
    expect(await first).toMatchObject({ ok: true, agentId: 'agent' })
    expect(launcher.launches()).toBe(1)
  })

  it('resumes again once a launch that failed has answered', async () => {
    await exitedSeat()
    const launcher = slowLauncher()
    const failed = sup.resume('seat-x')
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))
    launcher.open(new Error('surface gone'))
    expect(await failed).toMatchObject({ ok: false, reason: 'resume failed: surface gone' })

    const later = await sup.resume('seat-x')

    expect(later).toMatchObject({ ok: true, agentId: 'agent' })
    expect(launcher.launches()).toBe(2)
  })

  it('resumes again after a resumed run exits', async () => {
    await exitedSeat()
    const launcher = slowLauncher()
    launcher.open()
    expect(await sup.resume('seat-x')).toMatchObject({ ok: true })
    await recordExit()

    const later = await sup.resume('seat-x')

    expect(later).toMatchObject({ ok: true, agentId: 'agent' })
    expect(launcher.launches()).toBe(2)
  })
})
