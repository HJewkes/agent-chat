import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { burndownInstallVerb } from '../cli/verbs/burndown.js'
import type { VerbContext } from '../cli/command.js'
import { renderBurndownPlist } from '../mirror/plist.js'

const ctx: VerbContext = { warnings: [], format: 'human', withBroker: (() => {}) as never }

describe('renderBurndownPlist', () => {
  it('schedules on StartInterval, never KeepAlive, under the burndown label', () => {
    const plist = renderBurndownPlist({
      label: 'dev.hjewkes.agent-chat-burndown',
      nodePath: '/opt/node',
      cliEntry: '/repo/dist/cli.js',
      logDir: '/Users/o/Library/Logs/agent-chat-burndown',
      env: {},
      intervalSeconds: 600,
    })
    expect(plist).toContain('<string>dev.hjewkes.agent-chat-burndown</string>')
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

describe('burndown install', () => {
  it('prints the sign-off checklist and refuses while the config is not enabled', async () => {
    const report = await burndownInstallVerb.run({}, ctx)
    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toMatch(/enabled: false/)
    expect(report.lines[0]).toMatch(/Sign-off checklist/)
    expect(report.lines.some(l => l.includes('git push -u origin agent-chat/*'))).toBe(true)
    expect(report.lines.some(l => l.includes('reportTo'))).toBe(true)
  })
})
