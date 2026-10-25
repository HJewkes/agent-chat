import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerMachineAlias } from '../broker/launcher-key.js'
import { hostKeyNewReport } from '../cli/verbs/host.js'
import { knownMachineAliases } from '../agents/machine-registry.js'
import { resolveDestination } from '../agents/teleport-destination.js'
import { launcherKeyPath } from '../paths.js'

/** CC-1646 B: a machine registered by `host key-new` counts as a configured machine. */

const MAC = 'mac-a.example'
const BROKER = 'server-a.example'

let dir: string
let savedHome: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-machine-registry-'))
  savedHome = process.env.AGENT_CHAT_HOME
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = savedHome
  fs.rmSync(dir, { recursive: true, force: true })
})

const writeConfig = (machines: unknown): void =>
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ machines }))

describe('knownMachineAliases', () => {
  it('lists an alias registered by key-new', () => {
    hostKeyNewReport(MAC, 'mac', BROKER)

    expect(knownMachineAliases()).toEqual({ mac: MAC })
  })

  it('resolves a key-registered alias as a destination', () => {
    hostKeyNewReport(MAC, 'mac', BROKER)

    const result = resolveDestination({
      to: 'mac',
      callerHost: BROKER,
      brokerHost: BROKER,
      launchers: [{ host: MAC, platform: 'darwin' }],
      aliases: knownMachineAliases(),
    })

    expect(result).toEqual({ ok: true, destination: { site: 'launcher', host: MAC, platform: 'darwin' } })
  })

  it('lets a config entry win over a key-registered alias of the same name', () => {
    hostKeyNewReport(MAC, 'mac', BROKER)
    writeConfig({ mac: 'mac-b.example' })

    expect(knownMachineAliases()).toEqual({ mac: 'mac-b.example' })
  })

  it('keeps config-only and key-only aliases side by side', () => {
    hostKeyNewReport(MAC, 'mac', BROKER)
    writeConfig({ basement: BROKER })

    expect(knownMachineAliases()).toEqual({ mac: MAC, basement: BROKER })
  })

  it('omits a registered alias whose key file is group-readable', () => {
    hostKeyNewReport(MAC, 'mac', BROKER)
    fs.chmodSync(launcherKeyPath(MAC), 0o644)

    expect(knownMachineAliases()).toEqual({})
  })

  it('omits an alias recorded without a key', () => {
    registerMachineAlias('mac', MAC)

    expect(knownMachineAliases()).toEqual({})
  })

  it('is empty when nothing is configured or registered', () => {
    expect(knownMachineAliases()).toEqual({})
  })
})
