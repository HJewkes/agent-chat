import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { burndownInstall, burndownJobStatus, burndownUninstall } from '../cli/verbs/burndown.js'
import type { JobControl, Launchctl } from '../mirror/launchd.js'
import { renderBurndownPlist } from '../mirror/plist.js'

const LABEL = 'dev.hjewkes.agent-chat-burndown'
const SERVICE = `gui/501/${LABEL}`

describe('renderBurndownPlist', () => {
  it('schedules on StartInterval, never KeepAlive, under the burndown label', () => {
    const plist = renderBurndownPlist({
      label: LABEL,
      nodePath: '/opt/node',
      cliEntry: '/repo/dist/cli.js',
      logDir: '/Users/o/Library/Logs/agent-chat-burndown',
      env: {},
      intervalSeconds: 600,
    })
    expect(plist).toContain(`<string>${LABEL}</string>`)
    expect(plist).toContain('<key>StartInterval</key>\n  <integer>600</integer>')
    expect(plist).not.toContain('KeepAlive')
    expect(plist).toContain('<key>RunAtLoad</key>\n  <false/>')
    expect(plist).toContain(
      '<string>/repo/dist/cli.js</string>\n    <string>burndown</string>' +
        '\n    <string>tick</string>\n    <string>--once</string>',
    )
  })
})

let home: string
const savedHome = process.env.AGENT_CHAT_HOME

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-burndown-install-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = savedHome
})

/** Fails the test immediately if `install`'s refusal path ever reaches launchctl. */
const refusingControl: JobControl = {
  launchctl: () => {
    throw new Error('launchctl must not be called while refused')
  },
  uid: 501,
  dryRun: false,
  label: LABEL,
}

describe('burndownInstall', () => {
  it('prints the sign-off checklist and refuses, never touching launchctl, while the config is not enabled', () => {
    const report = burndownInstall(false, refusingControl)
    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toMatch(/enabled: false/)
    expect(report.lines[0]).toMatch(/Sign-off checklist/)
    expect(report.lines.some(l => l.includes('git push -u origin agent-chat/*'))).toBe(true)
    expect(report.lines.some(l => l.includes('reportTo'))).toBe(true)
  })
})

/** Records every call and answers `print` the way real launchd would; never touches the real domain. */
function fakeLaunchctl(loaded: boolean): { launchctl: Launchctl; calls: string[] } {
  const calls: string[] = []
  const launchctl: Launchctl = args => {
    calls.push(args.join(' '))
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, stdout: '\tstate = running\n\tpid = 4242\n', stderr: '' }
        : { code: 113, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { launchctl, calls }
}

describe('burndownUninstall', () => {
  it('boots the burndown service out and disables it under its own label', () => {
    const { launchctl, calls } = fakeLaunchctl(true)
    const control: JobControl = { launchctl, uid: 501, dryRun: false, label: LABEL }
    const result = burndownUninstall(control)
    expect(result.ok).toBe(true)
    expect(calls).toEqual([`print ${SERVICE}`, `bootout ${SERVICE}`, `disable ${SERVICE}`])
  })
})

describe('burndownJobStatus', () => {
  it("reports a loaded job's pid and the config state", () => {
    const { launchctl } = fakeLaunchctl(true)
    const control: JobControl = { launchctl, uid: 501, dryRun: false, label: LABEL }
    const report = burndownJobStatus(control)
    expect(report.ok).toBe(true)
    expect(report.lines[0]).toBe('launchd loaded, pid 4242')
    expect(report.lines.some(l => l.includes('config enabled=false'))).toBe(true)
  })

  it('reports an unloaded job', () => {
    const { launchctl } = fakeLaunchctl(false)
    const control: JobControl = { launchctl, uid: 501, dryRun: false, label: LABEL }
    expect(burndownJobStatus(control).lines[0]).toBe('launchd not loaded')
  })
})
