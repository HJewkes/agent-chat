import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_BROKER_REFUSAL, heldRelayInstallOn } from '../cli/verbs/held-relay-job.js'
import type { JobHost } from '../mirror/job-host.js'
import type { Launchctl } from '../mirror/launchd.js'
import type { Systemctl } from '../mirror/systemd.js'

let scratch: string
let savedHome: string | undefined
let savedState: string | undefined

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-held-relay-job-'))
  savedHome = process.env.AGENT_CHAT_HOME
  savedState = process.env.XDG_STATE_HOME
  delete process.env.AGENT_CHAT_HOME
  process.env.XDG_STATE_HOME = path.join(scratch, 'state')
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
  for (const [key, value] of [
    ['AGENT_CHAT_HOME', savedHome],
    ['XDG_STATE_HOME', savedState],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function host(platform: NodeJS.Platform): { host: JobHost; calls: string[] } {
  const calls: string[] = []
  const launchctl: Launchctl = args => {
    calls.push(`launchctl ${args.join(' ')}`)
    return { code: 113, stdout: '', stderr: '' }
  }
  const systemctl: Systemctl = args => {
    calls.push(`systemctl ${args.join(' ')}`)
    return { code: 0, stdout: '', stderr: '' }
  }
  const unitDir = path.join(scratch, 'systemd', 'user')
  return { host: { platform, launchctl, systemctl, uid: 501, unitDir, dryRun: true }, calls }
}

describe('held-relay job install', () => {
  it('renders a plist running seats held-relay every everyMinutes, loading nothing', () => {
    const { host: mac, calls } = host('darwin')

    const report = heldRelayInstallOn(mac, { everyMinutes: 7 })

    expect(report.ok).toBe(true)
    expect(report.lines[0]).toContain('<string>held-relay</string>')
    expect(report.lines[0]).toContain('<key>StartInterval</key>\n  <integer>420</integer>')
    expect(report.lines[0]).toContain('dev.hjewkes.agent-chat-held-relay')
    expect(calls).toEqual(['launchctl print gui/501/dev.hjewkes.agent-chat-held-relay'])
  })

  it('renders systemd units on the same cadence on Linux, writing and calling nothing', () => {
    const { host: linux, calls } = host('linux')

    const report = heldRelayInstallOn(linux, { everyMinutes: 7 })

    expect(report.lines[0]).toContain('seats held-relay')
    expect(report.lines[1]).toContain('OnUnitActiveSec=420s')
    expect(calls).toEqual([])
    expect(fs.existsSync(linux.unitDir)).toBe(false)
  })

  it('refuses a --agent-chat-home inside a temp dir before rendering', () => {
    const { host: linux } = host('linux')

    const report = heldRelayInstallOn(linux, {
      everyMinutes: 10,
      agentChatHome: path.join(os.tmpdir(), 'relay-home'),
    })

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual([])
    expect(report.errors?.[0]).toContain('temp dir')
  })

  it('refuses on a remoteBroker host, before rendering or calling anything', () => {
    const { host: mac, calls } = host('darwin')

    const report = heldRelayInstallOn(mac, { everyMinutes: 10, remoteBroker: true })

    expect(report).toEqual({ ok: false, lines: [], errors: [REMOTE_BROKER_REFUSAL] })
    expect(calls).toEqual([])
  })
})
