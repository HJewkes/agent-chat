import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDestination, type DestinationInput } from '../agents/teleport-destination.js'
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
    const launchers = [{ host: MAC, platform: 'darwin' as const }]

    expect(resolveDestination(fromMac({ callerHost: BROKER, to: 'mac', launchers }))).toEqual({
      ok: true,
      destination: { site: 'launcher', host: MAC, platform: 'darwin' },
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
