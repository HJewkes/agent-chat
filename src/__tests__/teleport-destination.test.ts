import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  remotePathBlocker,
  resolveDestination,
  type DestinationInput,
} from '../agents/teleport-destination.js'
import { resolveMachines } from '../config.js'

/** CC-951 e: which machine a teleport lands on, and who launches it there. */

const MAC = 'laptop-host'
const BROKER = 'server-host'
const ALIASES = { mac: MAC, basement: BROKER }

const fromMac = (over: Partial<DestinationInput> = {}): DestinationInput => ({
  callerHost: MAC,
  brokerHost: BROKER,
  launchers: [],
  aliases: ALIASES,
  ...over,
})

describe('teleport destination', () => {
  it('sends a Mac caller asking for the broker machine to the broker site', () => {
    expect(resolveDestination(fromMac({ to: 'basement' }))).toEqual({
      ok: true,
      destination: { site: 'broker', host: BROKER },
    })
  })

  it("stays on the caller's own host when no machine is named", () => {
    expect(resolveDestination(fromMac())).toEqual({ ok: true, destination: { site: 'caller', host: MAC } })
  })

  it("uses the broker site for a caller on the broker's own host", () => {
    expect(resolveDestination(fromMac({ callerHost: BROKER }))).toEqual({
      ok: true,
      destination: { site: 'broker', host: BROKER },
    })
  })

  it('resolves an alias through the configured machines, ignoring case', () => {
    expect(resolveDestination(fromMac({ to: 'MAC' }))).toEqual({
      ok: true,
      destination: { site: 'caller', host: MAC },
    })
  })

  it('accepts a bare hostname with no alias', () => {
    expect(resolveDestination(fromMac({ to: BROKER }))).toMatchObject({
      ok: true,
      destination: { site: 'broker' },
    })
  })

  it('refuses a configured machine with no launcher connected, naming the known machines', () => {
    const result = resolveDestination(fromMac({ callerHost: BROKER, to: 'mac' }))

    expect(result).toEqual({
      ok: false,
      reason: `no launcher connected on ${MAC}; known machines: mac (${MAC}), basement (${BROKER}), ${BROKER}`,
    })
  })

  it('refuses an unknown machine, naming the known ones', () => {
    const result = resolveDestination(fromMac({ to: 'attic' }))

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^unknown machine "attic"; known machines: mac/),
    })
  })

  it('routes to a connected launcher with its reported platform', () => {
    const launchers = [{ host: MAC, platform: 'darwin' as const, proved: true }]

    expect(resolveDestination(fromMac({ callerHost: BROKER, to: 'mac', launchers }))).toEqual({
      ok: true,
      destination: { site: 'launcher', host: MAC, platform: 'darwin' },
    })
  })
})

/** CC-1331: a launcher is chosen only on a configured machine whose hello proved its host key. */
describe('teleport destination on a launcher', () => {
  const ATTIC = 'attic-a.example'
  const fromBroker = (proved: boolean, aliases: Record<string, string>): DestinationInput => ({
    to: ATTIC,
    callerHost: BROKER,
    brokerHost: BROKER,
    launchers: [{ host: ATTIC, platform: 'linux', proved }],
    aliases,
  })

  it.each([
    [true, { attic: ATTIC }, true],
    [false, { attic: ATTIC }, false],
    [true, {}, false],
    [false, {}, false],
  ])('proved %s with aliases %j routes to the launcher: %s', (proved, aliases, routed) => {
    const result = resolveDestination(fromBroker(proved, aliases))

    expect(result.ok && result.destination.site === 'launcher').toBe(routed)
  })

  it('never chooses a keyless launcher for an unconfigured host, even named by raw hostname', () => {
    expect(resolveDestination(fromBroker(false, {}))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^attic-a\.example is not one of the configured machines/),
    })
  })

  it('refuses an unconfigured host whose launcher proved its key, naming machines', () => {
    expect(resolveDestination(fromBroker(true, {}))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('is not one of the configured machines'),
    })
  })

  it('refuses a configured machine whose launcher has not proved its key, naming which', () => {
    expect(resolveDestination(fromBroker(false, { attic: ATTIC }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^the launcher on attic-a\.example has not proved its host key/),
    })
  })

  it('still resolves a raw hostname equal to the broker host with no aliases', () => {
    expect(resolveDestination({ ...fromBroker(false, {}), to: BROKER, callerHost: MAC })).toEqual({
      ok: true,
      destination: { site: 'broker', host: BROKER },
    })
  })

  it('leaves an unproved or unconfigured launcher out of the known machines', () => {
    const input = { ...fromBroker(false, {}), to: 'nowhere' }

    expect(resolveDestination(input)).toEqual({
      ok: false,
      reason: `unknown machine "nowhere"; known machines: ${BROKER}`,
    })
  })
})

describe('config machines', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-machines-'))
    process.env.AGENT_CHAT_HOME = dir
  })

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const writeConfig = (machines: unknown): void =>
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ machines }))

  it('is empty when unset', () => {
    expect(resolveMachines()).toEqual({})
  })

  it('reads an alias map', () => {
    writeConfig(ALIASES)

    expect(resolveMachines()).toEqual(ALIASES)
  })

  it('falls back to empty when any entry is not a hostname', () => {
    writeConfig({ mac: MAC, basement: '' })

    expect(resolveMachines()).toEqual({})
  })
})

describe('a path handed to a launcher on another machine', () => {
  const home = '/srv/h'

  it('passes a normal path strictly under home', () => {
    expect(remotePathBlocker('cwd', '/srv/h/projects/x', home)).toBeUndefined()
  })

  it.each([
    ['/srv/h/../other/x', 'normalised'],
    ['projects/x', 'normalised'],
    ['/srv/h', 'not under the home directory'],
    ['/etc/x', 'not under the home directory'],
    ['/srv/h/.ssh/x', 'protected directory'],
  ])('refuses %s', (dir, why) => {
    expect(remotePathBlocker('cwd', dir, home)).toContain(why)
  })
})
