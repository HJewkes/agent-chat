import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GH_KEY_ROOT_ENV, writeGhShim } from '../gh-shim/install.js'
import { GH_BUDGET_URL_ENV } from '../gh-shim/rate-limit.js'
import { GH_WRITE_TICKET_ENV, mintTicket } from '../gh-shim/ticket.js'
import { writeGhWriteKey } from '../gh-shim/write-key.js'
import { AGENT_ID_ENV } from '../launch-identity.js'

/**
 * CC-1644: through the script run-agent writes, against the built `dist/gh-shim/main.js`, a gh
 * command that is neither a known read nor carries gh-write's ticket for its exact argv never
 * starts the real gh. The fake gh behind the shim records each argv and whether it saw a ticket.
 */

const MAIN = path.join(import.meta.dirname, '..', '..', 'dist', 'gh-shim', 'main.js')
const AGENT = 'ag0000b2'
const COMMENT = ['issue', 'comment', '3', '--body', 'synthetic words']

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs')
const ticket = process.env.${GH_WRITE_TICKET_ENV} !== undefined
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: process.argv.slice(2), ticket }) + '\\n')
`

let dir: string
let env: Record<string, string>
const file = (name: string): string => path.join(dir, name)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-write-gate-'))
  fs.mkdirSync(file('fake'))
  fs.writeFileSync(file('fake/gh'), FAKE_GH, { mode: 0o755 })
  const shimDir = writeGhShim(file('shim'), process.execPath, MAIN, file('keys'))
  env = {
    PATH: [shimDir, file('fake'), '/usr/bin', '/bin'].join(':'),
    FAKE_GH_LOG: file('gh.log'),
    AGENT_CHAT_HOME: file('home'),
    XDG_STATE_HOME: file('state'),
    [AGENT_ID_ENV]: AGENT,
    [GH_BUDGET_URL_ENV]: 'http://127.0.0.1:1/rpc/shepherd.ghBudget',
  }
  fs.mkdirSync(file('home'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const gh = (args: string[]) => spawnSync('gh', args, { cwd: dir, env, encoding: 'utf8', timeout: 30_000 })

const realGhRuns = (): { args: string[]; ticket: boolean }[] =>
  fs.existsSync(file('gh.log'))
    ? fs
        .readFileSync(file('gh.log'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { args: string[]; ticket: boolean })
    : []

const ticketFor = (args: string[], root = file('keys')): string => {
  const key = fs.readFileSync(path.join(writeGhWriteKey(AGENT, root), AGENT), 'utf8').trim()
  return mintTicket(key, AGENT, args, Date.now())
}

const expectRefused = (result: ReturnType<typeof gh>): void => {
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/^gh-shim: refused \(write\): .*agent-chat gh-write -- <args>/)
  expect(realGhRuns()).toEqual([])
}

describe('the gh shim write gate (CC-1644)', () => {
  it('refuses a write with no ticket before the real gh starts, and logs its shape but not its text', () => {
    expectRefused(gh(COMMENT))

    const log = fs.readFileSync(file('home/leak-guard.log'), 'utf8')
    expect(log).toMatch(/ gh-shim: refused \(write\): issue comment\n$/)
    expect(log).not.toContain('synthetic')
  })

  it('still refuses with AGENT_CHAT_GH_SHIM_OFF set', () => {
    env.AGENT_CHAT_GH_SHIM_OFF = '1'

    expectRefused(gh(COMMENT))
  })

  it('runs a write that carries the ticket for its exact argv, and hides the ticket from the real gh', () => {
    env[GH_WRITE_TICKET_ENV] = ticketFor(COMMENT)

    const result = gh(COMMENT)

    expect(result.status).toBe(0)
    expect(realGhRuns()).toEqual([{ args: COMMENT, ticket: false }])
  })

  it('refuses a ticket minted for another argv', () => {
    env[GH_WRITE_TICKET_ENV] = ticketFor(COMMENT)

    expectRefused(gh(['issue', 'comment', '3', '--body', 'other words']))
  })

  it('refuses a ticket signed with a key at a root the agent chose', () => {
    env[GH_KEY_ROOT_ENV] = file('agent-keys')
    env[GH_WRITE_TICKET_ENV] = ticketFor(COMMENT, file('agent-keys'))

    expectRefused(gh(COMMENT))
  })

  it('runs a known read with no ticket', () => {
    const result = gh(['auth', 'git-credential', 'get'])

    expect(result.status).toBe(0)
    expect(realGhRuns()).toEqual([{ args: ['auth', 'git-credential', 'get'], ticket: false }])
  })
})
