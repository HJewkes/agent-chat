import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ledgerLockHolder, withLedgerLock } from '../agents/burndown/ledger.js'
import { burndownKicker, KICK_DEBOUNCE_MS, kickCommand, type KickPorts } from '../broker/burndown-kick.js'
import { cliEntry } from '../paths.js'
import { jobEnv } from '../mirror/plist.js'
import type { AppendInput } from '../broker/event-store.js'

const BURNDOWN_AGENTS = new Set(['bd-1', 'bd-2', 'bd-3'])

const exited = (ref: string): AppendInput => ({ kind: 'agent_exited', actor: ref, ref })
const retired = (ref: string): AppendInput => ({ kind: 'agent_retired', actor: 'human', target: ref, ref })

interface Harness {
  ports: KickPorts
  launches: Array<() => void>
  events: string[]
  holder: { pid: number | undefined }
}

function harness(): Harness {
  const launches: Array<() => void> = []
  const events: string[] = []
  const holder: { pid: number | undefined } = { pid: undefined }
  const ports: KickPorts = {
    isBurndownSpawn: id => BURNDOWN_AGENTS.has(id),
    lockHolder: () => holder.pid,
    launch: done => launches.push(done),
    log: event => events.push(event),
  }
  return { ports, launches, events, holder }
}

describe('burndown kick on a freed slot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('launches one tick a debounce after a burndown agent exits', () => {
    const h = harness()
    const kicker = burndownKicker(h.ports)

    kicker.offer(exited('bd-1'))
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS - 1)
    const early = h.launches.length
    vi.advanceTimersByTime(1)

    expect(early).toBe(0)
    expect(h.launches).toHaveLength(1)
  })

  it('coalesces exits and a claim release inside the window into one tick', () => {
    const h = harness()
    const kicker = burndownKicker(h.ports)

    kicker.offer(exited('bd-1'))
    vi.advanceTimersByTime(10_000)
    kicker.offer(retired('bd-2'))
    kicker.offer(exited('bd-3'))
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS)

    expect(h.launches).toHaveLength(1)
  })

  it('ignores exits of agents the tick did not spawn and rows that free no slot', () => {
    const h = harness()
    const kicker = burndownKicker(h.ports)

    kicker.offer(exited('hand-spawned'))
    kicker.offer({ kind: 'agent_spawned', actor: 'human', msgId: 'bd-1' })
    kicker.offer({ kind: 'agent_exited', actor: 'x' })
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS * 4)

    expect(h.launches).toHaveLength(0)
  })

  it('refuses to launch while another tick holds the ledger lock, then launches once it is free', () => {
    const h = harness()
    const kicker = burndownKicker(h.ports)
    h.holder.pid = 4242

    kicker.offer(exited('bd-1'))
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS * 3)
    const whileHeld = h.launches.length
    h.holder.pid = undefined
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS)

    expect(whileHeld).toBe(0)
    expect(h.events.filter(e => e === 'burndown_kick_deferred')).toHaveLength(3)
    expect(h.launches).toHaveLength(1)
  })

  it('never overlaps its own kicked tick, and runs one follow-up after it for exits seen meanwhile', () => {
    const h = harness()
    const kicker = burndownKicker(h.ports)

    kicker.offer(exited('bd-1'))
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS)
    kicker.offer(exited('bd-2'))
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS * 2)
    const duringFirst = h.launches.length
    h.launches[0]?.()
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS)

    expect(duringFirst).toBe(1)
    expect(h.launches).toHaveLength(2)
  })

  it('launches nothing after stop', () => {
    const h = harness()
    const kicker = burndownKicker(h.ports)

    kicker.offer(exited('bd-1'))
    kicker.stop()
    vi.advanceTimersByTime(KICK_DEBOUNCE_MS * 2)

    expect(h.launches).toHaveLength(0)
  })
})

describe('ledgerLockHolder', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-lock-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('names the live tick holding the lock the timer tick takes', async () => {
    const file = path.join(dir, 'burndown.json')

    const seen = await withLedgerLock(file, () => ledgerLockHolder(file))

    expect(seen).toEqual({ ran: true, value: process.pid })
    expect(ledgerLockHolder(file)).toBeUndefined()
  })

  it('treats a lock left by a dead process as free', () => {
    const file = path.join(dir, 'burndown.json')
    fs.writeFileSync(`${file}.lock`, '999999\n')

    expect(ledgerLockHolder(file)).toBeUndefined()
  })
})

describe('kicked tick env', () => {
  const BUS = { XDG_RUNTIME_DIR: 'synthetic-runtime-dir', DBUS_SESSION_BUS_ADDRESS: 'synthetic-bus-address' }

  it("a kicked tick carries the broker's user bus", () => {
    const source = { HOME: 'synthetic-home', PATH: '/usr/bin', ...BUS }

    const { env } = kickCommand(source)

    expect(env).toMatchObject(BUS)
  })

  it.each([
    ['unset', {}],
    ['empty', { XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' }],
  ])('a broker with a %s user bus kicks without one', (_label, bus) => {
    const { env } = kickCommand({ HOME: 'synthetic-home', PATH: '/usr/bin', ...bus })

    expect(Object.keys(env)).not.toContain('XDG_RUNTIME_DIR')
    expect(Object.keys(env)).not.toContain('DBUS_SESSION_BUS_ADDRESS')
  })

  it('the kick passes nothing else', () => {
    const source = {
      HOME: 'synthetic-home',
      PATH: '/usr/bin',
      AGENT_CHAT_NAME: 'a-name',
      AGENT_CHAT_AGENT_ID: 'an-id',
      SECRET_TOKEN: 'synthetic',
      ...BUS,
    }

    const { env } = kickCommand(source)

    expect(Object.keys(env).sort()).toEqual([...Object.keys(jobEnv(source)), ...Object.keys(BUS)].sort())
  })

  it("the kick runs the timer's command", () => {
    const { command, args } = kickCommand({})

    expect(command).toBe(process.execPath)
    expect(args).toEqual([cliEntry(), 'burndown', 'tick', '--once'])
  })
})
