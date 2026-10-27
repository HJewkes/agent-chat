import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GH_KEY_ROOT_ENV, writeGhShim } from '../gh-shim/install.js'
import { GH_BUDGET_URL_ENV } from '../gh-shim/rate-limit.js'
import { runShim } from '../gh-shim/shim.js'
import { GH_WRITE_TICKET_ENV, mintTicket } from '../gh-shim/ticket.js'
import { callerFields, GATE_MODE } from '../gh-shim/write-gate.js'
import { writeGhWriteKey } from '../gh-shim/write-key.js'
import { AGENT_ID_ENV } from '../launch-identity.js'

/**
 * CC-1644: a gh command that is neither a known read nor carries gh-write's ticket for its exact
 * argv is refused under `enforce` (the shipped mode), and under `log` runs with a would-refuse line.
 * The fake gh behind the shim records each argv and whether it saw a ticket.
 */

const MAIN = path.join(import.meta.dirname, '..', '..', 'dist', 'gh-shim', 'main.js')
const AGENT = 'ag0000b2'
const COMMENT = ['issue', 'comment', '3', '--body', 'synthetic words']
const HAS_PROC = fs.existsSync('/proc/self/cmdline')

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs')
const ticket = process.env.${GH_WRITE_TICKET_ENV} !== undefined
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: process.argv.slice(2), ticket }) + '\\n')
`

let dir: string
let shimDir: string
let env: Record<string, string>
const file = (name: string): string => path.join(dir, name)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-write-gate-'))
  fs.mkdirSync(file('fake'))
  fs.mkdirSync(file('home'))
  fs.writeFileSync(file('fake/gh'), FAKE_GH, { mode: 0o755 })
  shimDir = writeGhShim(file('shim'), process.execPath, MAIN, file('keys'))
  env = {
    FAKE_GH_LOG: file('gh.log'),
    AGENT_CHAT_HOME: file('home'),
    AGENT_CHAT_NAME: 'gate-tester',
    XDG_STATE_HOME: file('state'),
    [AGENT_ID_ENV]: AGENT,
    [GH_BUDGET_URL_ENV]: 'http://127.0.0.1:1/rpc/shepherd.ghBudget',
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const realGhRuns = (): { args: string[]; ticket: boolean }[] =>
  fs.existsSync(file('gh.log'))
    ? fs
        .readFileSync(file('gh.log'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { args: string[]; ticket: boolean })
    : []

const leakLog = (): string =>
  fs.existsSync(file('home/leak-guard.log')) ? fs.readFileSync(file('home/leak-guard.log'), 'utf8') : ''

const ticketFor = (args: string[], root = file('keys')): string => {
  const key = fs.readFileSync(path.join(writeGhWriteKey(AGENT, root), AGENT), 'utf8').trim()
  return mintTicket(key, AGENT, args, Date.now())
}

describe('the gh shim write gate as shipped, in enforce mode (CC-1644)', () => {
  const gh = (args: string[]) =>
    spawnSync('gh', args, {
      cwd: dir,
      env: { ...env, PATH: [shimDir, file('fake'), '/usr/bin', '/bin'].join(':') },
      encoding: 'utf8',
      timeout: 30_000,
    })

  const expectShimRefused = (result: ReturnType<typeof gh>): void => {
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^gh-shim: refused \(write\): .*agent-chat gh-write -- <args>/)
    expect(realGhRuns()).toEqual([])
  }

  it('ships in enforce mode', () => {
    expect(GATE_MODE).toBe('enforce')
  })

  it('refuses a write with no ticket and logs a refused line with its caller, never its text', () => {
    expectShimRefused(gh(COMMENT))

    const parent = HAS_PROC ? ' parent=\\S+ \\S+' : ''
    expect(leakLog()).toMatch(
      new RegExp(` gh-shim: refused \\(write\\): issue comment caller=gate-tester${parent}\\n$`),
    )
    expect(leakLog()).not.toContain('synthetic')
  })

  it('keeps enforce mode whatever the env says', () => {
    env.AGENT_CHAT_GH_SHIM_OFF = '1'
    env.AGENT_CHAT_GH_GATE_MODE = 'log'

    expectShimRefused(gh(COMMENT))
  })

  it('does not honour a ticket signed with a key at a root the agent chose', () => {
    env[GH_KEY_ROOT_ENV] = file('agent-keys')
    env[GH_WRITE_TICKET_ENV] = ticketFor(COMMENT, file('agent-keys'))

    expectShimRefused(gh(COMMENT))
  })

  it('logs nothing for a ticketed write, and hides the ticket from the real gh', () => {
    env[GH_WRITE_TICKET_ENV] = ticketFor(COMMENT)

    expect(gh(COMMENT).status).toBe(0)
    expect(realGhRuns()).toEqual([{ args: COMMENT, ticket: false }])
    expect(leakLog()).toBe('')
  })

  it('logs nothing for a known read', () => {
    expect(gh(['auth', 'git-credential', 'get']).status).toBe(0)
    expect(leakLog()).toBe('')
  })
})

describe('the gh shim write gate in enforce mode', () => {
  let stderr: string[]

  beforeEach(() => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.stubEnv('PATH', [file('fake'), '/usr/bin', '/bin'].join(':'))
    stderr = []
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk))
      return true
    })
  })

  const expectRefused = (code: number): void => {
    expect(code).toBe(1)
    expect(stderr.join('')).toMatch(/^gh-shim: refused \(write\): .*agent-chat gh-write -- <args>/)
    expect(realGhRuns()).toEqual([])
  }

  it('refuses a write with no ticket before the real gh starts, and logs its shape but not its text', async () => {
    expectRefused(await runShim(COMMENT, 'enforce'))

    expect(leakLog()).toMatch(/ gh-shim: refused \(write\): issue comment caller=gate-tester/)
    expect(leakLog()).not.toContain('synthetic')
  })

  it('still refuses with AGENT_CHAT_GH_SHIM_OFF set', async () => {
    vi.stubEnv('AGENT_CHAT_GH_SHIM_OFF', '1')

    expectRefused(await runShim(COMMENT, 'enforce'))
  })

  it('refuses a ticket minted for another argv', async () => {
    vi.stubEnv(GH_KEY_ROOT_ENV, file('keys'))
    vi.stubEnv(GH_WRITE_TICKET_ENV, ticketFor(COMMENT))

    expectRefused(await runShim(['issue', 'comment', '3', '--body', 'other words'], 'enforce'))
  })

  it('runs a write that carries the ticket for its exact argv', async () => {
    vi.stubEnv(GH_KEY_ROOT_ENV, file('keys'))
    vi.stubEnv(GH_WRITE_TICKET_ENV, ticketFor(COMMENT))

    expect(await runShim(COMMENT, 'enforce')).toBe(0)
    expect(realGhRuns()).toEqual([{ args: COMMENT, ticket: false }])
  })

  it('runs a known read with no ticket', async () => {
    expect(await runShim(['auth', 'git-credential', 'get'], 'enforce')).toBe(0)
    expect(realGhRuns()).toEqual([{ args: ['auth', 'git-credential', 'get'], ticket: false }])
  })
})

describe('the gh shim write gate in log mode', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.stubEnv('PATH', [file('fake'), '/usr/bin', '/bin'].join(':'))
  })

  it('runs a write with no ticket and logs a would-refuse line with its caller, never its text', async () => {
    expect(await runShim(COMMENT, 'log')).toBe(0)

    expect(realGhRuns()).toEqual([{ args: COMMENT, ticket: false }])
    expect(leakLog()).toMatch(/ gh-shim: would-refuse \(write\): issue comment caller=gate-tester/)
    expect(leakLog()).not.toContain('synthetic')
  })
})

describe('the caller fields of a gate log line', () => {
  it('keeps basenames of the agent name and the parent argv', () => {
    expect(
      callerFields({ AGENT_CHAT_NAME: 'fc-plan' }, ['/usr/bin/node', '/opt/factory/dist/bin.js', 'x']),
    ).toBe('caller=fc-plan parent=node bin.js')
  })

  it('logs a word that may be free text as ?, and leaves out a parent it cannot read', () => {
    expect(callerFields({}, ['bash', 'gh pr comment --body private words'])).toBe('caller=? parent=bash ?')
    expect(callerFields({ AGENT_CHAT_NAME: 'a b' }, undefined)).toBe('caller=?')
  })
})
