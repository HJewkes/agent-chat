import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadMirrorConfig, parseEnvFile, readAsToken } from '../mirror/config.js'
import { mirrorJobEnv, renderMirrorPlist } from '../mirror/plist.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mirror-config-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function envFile(body: string, mode: number): string {
  const file = path.join(dir, 'mirror.env')
  fs.writeFileSync(file, body)
  fs.chmodSync(file, mode)
  return file
}

describe('readAsToken', () => {
  it('refuses a group- or world-readable env file', () => {
    const file = envFile('EDGE1_AS_TOKEN=syt_secret\n', 0o644)
    expect(() => readAsToken(file)).toThrow(/is 0644; must be 0600/)
  })

  it('reads the token from a 0600 file without putting it in process.env', () => {
    const file = envFile('# appservice\nEDGE1_AS_TOKEN="syt_secret"\n', 0o600)
    expect(readAsToken(file)).toBe('syt_secret')
    expect(process.env['EDGE1_AS_TOKEN']).toBeUndefined()
  })

  it('names the missing key rather than returning an empty token', () => {
    const file = envFile('OTHER=1\n', 0o600)
    expect(() => readAsToken(file)).toThrow(/has no EDGE1_AS_TOKEN/)
  })

  it('says the file is absent when it is', () => {
    expect(() => readAsToken(path.join(dir, 'nope.env'))).toThrow(/is absent/)
  })
})

describe('parseEnvFile', () => {
  it('skips comments and blank lines and keeps = inside a value', () => {
    const parsed = parseEnvFile("\n# c\nA=b=c\nB = 'q'\n")
    expect([...parsed]).toEqual([
      ['A', 'b=c'],
      ['B', 'q'],
    ])
  })
})

describe('loadMirrorConfig', () => {
  const write = (value: unknown): string => {
    const file = path.join(dir, 'mirror.json')
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }
  const minimal = {
    homeserverUrl: 'https://chat.example.org',
    serverName: 'example.org',
    ownerUserId: '@owner:example.org',
  }

  it('derives the mirror user, room alias and machine from the server name', () => {
    expect(loadMirrorConfig(write(minimal))).toEqual({
      ...minimal,
      mirrorUserId: '@ac-edge1:example.org',
      roomAlias: '#queue:example.org',
      machine: 'edge1',
    })
  })

  it('refuses a token pasted into the config file', () => {
    expect(() => loadMirrorConfig(write({ ...minimal, asToken: 'syt_x' }))).toThrow(/asToken/)
  })

  it('refuses an owner that is not a Matrix user id', () => {
    expect(() => loadMirrorConfig(write({ ...minimal, ownerUserId: 'owner' }))).toThrow(/invalid/)
  })
})

describe('renderMirrorPlist', () => {
  const callerEnv = {
    HOME: '/Users/o',
    PATH: '/usr/bin',
    EDGE1_AS_TOKEN: 'syt_leaked',
    SECRET: 'x',
  }
  const render = (env: NodeJS.ProcessEnv) =>
    renderMirrorPlist({
      nodePath: '/opt/node',
      cliEntry: '/repo/dist/cli.js',
      logDir: '/Users/o/Library/Logs/agent-chat-mirror',
      env: mirrorJobEnv(env),
    })

  it('runs `mirror run` and carries no token, even when the caller has one in its env', () => {
    const plist = render(callerEnv)
    expect(plist).toContain(
      '<string>/repo/dist/cli.js</string>\n    <string>mirror</string>\n    <string>run</string>',
    )
    expect(plist).not.toMatch(/EDGE1_AS_TOKEN|syt_|SECRET/)
  })

  it('passes AGENT_CHAT_HOME only when it is set', () => {
    expect(render(callerEnv)).not.toContain('AGENT_CHAT_HOME')
    expect(render({ ...callerEnv, AGENT_CHAT_HOME: '/tmp/ac' })).toContain(
      '<key>AGENT_CHAT_HOME</key>\n    <string>/tmp/ac</string>',
    )
  })

  it('keeps the job alive, throttled, and logging under ~/Library/Logs', () => {
    const plist = render(callerEnv)
    expect(plist).toContain('<string>dev.hjewkes.agent-chat-mirror</string>')
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>')
    expect(plist).toContain('<string>/Users/o/Library/Logs/agent-chat-mirror/mirror.log</string>')
  })

  it('escapes XML in paths', () => {
    const plist = renderMirrorPlist({ nodePath: '/a&b/<node>', cliEntry: '/c', logDir: '/l', env: {} })
    expect(plist).toContain('<string>/a&amp;b/&lt;node&gt;</string>')
  })
})
