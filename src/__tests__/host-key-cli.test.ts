import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brokerKeyFor, readMachineAliases } from '../broker/launcher-key.js'
import { hostKeyNewReport } from '../cli/verbs/host.js'
import { launcherAliasesPath, launcherKeyPath } from '../paths.js'

/**
 * CC-1646 A: `host key-new` is the owner's one registration step. It must leave a
 * 0600 key and an alias beside it, and must never echo the key.
 */

const HOST = 'mac-host.example.ts.net'

let dir: string
let savedHome: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-host-key-'))
  savedHome = process.env.AGENT_CHAT_HOME
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = savedHome
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('hostKeyNewReport', () => {
  it('creates an owner-only key and records the alias beside it', () => {
    const report = hostKeyNewReport(HOST, 'mac', 'broker-box')

    expect(report.ok).toBe(true)
    expect(fs.statSync(launcherKeyPath(HOST)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(launcherAliasesPath()).mode & 0o777).toBe(0o600)
    expect(readMachineAliases()).toEqual({ mac: HOST })
  })

  it('leaves the key and the alias unchanged when run twice', () => {
    hostKeyNewReport(HOST, 'mac', 'broker-box')
    const first = brokerKeyFor(HOST)

    hostKeyNewReport(HOST, 'mac', 'broker-box')

    expect(brokerKeyFor(HOST)).toBe(first)
    expect(readMachineAliases()).toEqual({ mac: HOST })
  })

  it('keeps earlier aliases when another host is registered', () => {
    hostKeyNewReport(HOST, 'mac', 'broker-box')
    hostKeyNewReport('other.example.ts.net', 'other', 'broker-box')

    expect(readMachineAliases()).toEqual({ mac: HOST, other: 'other.example.ts.net' })
  })

  it('prints the path and the pull command but never the key', () => {
    const report = hostKeyNewReport(HOST, 'mac', 'broker-box')
    const key = brokerKeyFor(HOST) as string
    const out = report.lines.join('\n')

    expect(out).toContain(launcherKeyPath(HOST))
    expect(out).toContain('scp broker-box:')
    expect(out).toContain('chmod 600 ~/.agent-chat/launcher.key')
    expect(out).not.toContain(key)
  })

  it('registers a key without an alias when none is given', () => {
    const report = hostKeyNewReport(HOST, undefined, 'broker-box')

    expect(report.ok).toBe(true)
    expect(brokerKeyFor(HOST)).not.toBeNull()
    expect(readMachineAliases()).toEqual({})
  })

  it('refuses a path-like host and writes nothing', () => {
    const report = hostKeyNewReport('../evil', 'mac', 'broker-box')

    expect(report.ok).toBe(false)
    expect(fs.existsSync(launcherAliasesPath())).toBe(false)
  })

  it('refuses a path-like alias before minting a key', () => {
    const report = hostKeyNewReport(HOST, '../x', 'broker-box')

    expect(report.ok).toBe(false)
    expect(brokerKeyFor(HOST)).toBeNull()
  })
})
