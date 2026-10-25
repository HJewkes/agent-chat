import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchExitHook } from '../agents/launch-agent.js'
import { runGhWrite, ticketedRunGh } from '../cli/gh-write.js'
import { scanDeps } from '../gh-write/scan.js'
import type { ThrottleDeps } from '../gh-write/throttle.js'
import { GH_KEY_ROOT_ENV, writeGhShim } from '../gh-shim/install.js'
import { GH_WRITE_TICKET_ENV, mintTicket, TICKET_TTL_MS, verifyTicket } from '../gh-shim/ticket.js'
import { readGhWriteKey, removeGhWriteKey, writeGhWriteKey } from '../gh-shim/write-key.js'
import { guardContext, REASONS, checkToolCall } from '../leak-guard/pretool.js'

const KEY = 'a'.repeat(64)
const AGENT = 'ag000001'
const ARGV = ['issue', 'comment', '1', '--body-file', '/scratch/gh-write-x/source-1']
const NOW = 1_700_000_000_000

let dir: string
let savedPath: string | undefined
const file = (name: string): string => path.join(dir, name)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ghw-ticket-'))
  savedPath = process.env.PATH
})

afterEach(() => {
  process.env.PATH = savedPath
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a gh-write ticket (CC-1644)', () => {
  it('verifies for the key, agent and argv it was minted for', () => {
    const ticket = mintTicket(KEY, AGENT, ARGV, NOW)

    expect(verifyTicket(KEY, AGENT, ARGV, ticket, NOW + 1)).toBe(true)
  })

  it('fails when one argv word changes, so it cannot carry other text or another command', () => {
    const ticket = mintTicket(KEY, AGENT, ARGV, NOW)

    expect(verifyTicket(KEY, AGENT, [...ARGV.slice(0, 2), '2', ...ARGV.slice(3)], ticket, NOW)).toBe(false)
    expect(verifyTicket(KEY, AGENT, ['pr', 'merge', '1'], ticket, NOW)).toBe(false)
  })

  it('fails for another agent or another key', () => {
    const ticket = mintTicket(KEY, AGENT, ARGV, NOW)

    expect(verifyTicket(KEY, 'ag000002', ARGV, ticket, NOW)).toBe(false)
    expect(verifyTicket('b'.repeat(64), AGENT, ARGV, ticket, NOW)).toBe(false)
  })

  it('fails once expired, and when it claims to live past the TTL', () => {
    const ticket = mintTicket(KEY, AGENT, ARGV, NOW)

    expect(verifyTicket(KEY, AGENT, ARGV, ticket, NOW + TICKET_TTL_MS)).toBe(false)
    expect(verifyTicket(KEY, AGENT, ARGV, ticket, NOW - 1)).toBe(false)
  })

  it('fails on malformed input without throwing', () => {
    const [, expiry, nonce, mac] = mintTicket(KEY, AGENT, ARGV, NOW).split('.')
    const bad = [
      undefined,
      7,
      '',
      'v1',
      `v2.${expiry}.${nonce}.${mac}`,
      `v1.${expiry}.${nonce}.${mac}.x`,
      `v1.${expiry}.${nonce}.zz`,
    ]

    for (const ticket of bad) expect(verifyTicket(KEY, AGENT, ARGV, ticket, NOW)).toBe(false)
  })
})

describe('the per-launch gh-write key', () => {
  it('is a fresh 0600 file in a 0700 dir at each launch', () => {
    const root = file('keys')
    writeGhWriteKey(AGENT, root)
    const first = readGhWriteKey(root, AGENT)
    writeGhWriteKey(AGENT, root)

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(readGhWriteKey(root, AGENT)).not.toBe(first)
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(root, AGENT)).mode & 0o777).toBe(0o600)
  })

  it('is refused when symlinked, loose, or named by a path-like id', () => {
    const root = file('keys')
    writeGhWriteKey(AGENT, root)
    fs.symlinkSync(path.join(root, AGENT), path.join(root, 'linked'))
    fs.writeFileSync(path.join(root, 'loose'), `${KEY}\n`, { mode: 0o644 })
    fs.chmodSync(path.join(root, 'loose'), 0o644)

    expect(readGhWriteKey(root, 'linked')).toBeNull()
    expect(readGhWriteKey(root, 'loose')).toBeNull()
    expect(readGhWriteKey(path.join(root, 'sub'), `../${AGENT}`)).toBeNull()
    expect(() => writeGhWriteKey('..', root)).toThrow(/unusable agent id/)
  })

  it('is removed by the run-agent exit hook, named launch or not', () => {
    const root = file('keys')
    writeGhWriteKey(AGENT, root)
    const removeKey = (agentId: string) => removeGhWriteKey(agentId, root)

    launchExitHook(AGENT, undefined, '/tmp', { reap: vi.fn(), removeTmp: vi.fn(), removeKey })()

    expect(fs.existsSync(path.join(root, AGENT))).toBe(false)
  })
})

describe('the gh shim script', () => {
  it('bakes the key root on its exec line, over one the agent set in env', () => {
    const main = file('main.js')
    fs.writeFileSync(main, `process.stdout.write(process.env.${GH_KEY_ROOT_ENV} ?? 'unset')\n`)
    const shim = path.join(writeGhShim(file('shim'), process.execPath, main, file('keys')), 'gh')

    const seen = execFileSync(shim, ['pr', 'view', '1'], {
      env: { PATH: process.env.PATH, [GH_KEY_ROOT_ENV]: file('agent-chosen') },
      encoding: 'utf8',
    })

    expect(seen).toBe(file('keys'))
  })
})

describe('gh-write hands gh a ticket for the argv it scanned', () => {
  // A fake gh that records each argument on its own line, then the ticket it was given.
  const installFakeGh = (): void => {
    fs.mkdirSync(file('bin'))
    fs.writeFileSync(
      file('bin/gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${file('argv')}"\nprintf '%s' "$${GH_WRITE_TICKET_ENV}" > "${file('ticket')}"\n`,
      { mode: 0o755 },
    )
    process.env.PATH = `${file('bin')}:${savedPath}`
  }
  const throttle = (runGh: ThrottleDeps['runGh']): ThrottleDeps => ({
    now: Date.now,
    sleep: () => Promise.resolve(),
    runGh,
    coreRemaining: () => Promise.resolve(undefined),
    notice: () => undefined,
    lockDir: file('lock'),
    stampPath: file('stamp'),
    gapMs: 0,
  })

  it('signs the copy path gh is given, after the scan passed', async () => {
    installFakeGh()
    const root = file('keys')
    const key = readGhWriteKey(writeGhWriteKey(AGENT, root), AGENT) ?? ''
    fs.writeFileSync(file('terms'), 'zq7privateseat\n', { mode: 0o600 })
    fs.writeFileSync(file('body.md'), 'A clean body.\n')
    const runGh = ticketedRunGh({ AGENT_CHAT_AGENT_ID: AGENT }, Date.now, root)

    const result = await runGhWrite(
      ['issue', 'comment', '1', '--body-file', file('body.md')],
      scanDeps(file('terms')),
      throttle(runGh),
    )

    const argv = fs.readFileSync(file('argv'), 'utf8').trimEnd().split('\n')
    expect(result.code).toBe(0)
    expect(argv).not.toContain(file('body.md'))
    expect(verifyTicket(key, AGENT, argv, fs.readFileSync(file('ticket'), 'utf8'), Date.now())).toBe(true)
  })

  it('gives gh no ticket outside a launch that holds a key', async () => {
    installFakeGh()

    await ticketedRunGh({ AGENT_CHAT_AGENT_ID: AGENT }, Date.now, file('no-keys'))(['pr', 'view', '1'])

    expect(fs.readFileSync(file('ticket'), 'utf8')).toBe('')
  })
})

describe('the key dir in the pretool guard', () => {
  it('is protected under a relocated AGENT_CHAT_HOME the hooks-root substring misses', () => {
    vi.stubEnv('AGENT_CHAT_HOME', '/state/zq7home')
    const ctx = guardContext({ PATH: '', AGENT_CHAT_HOME: '/state/zq7home' }, '/repo', '/home/example')

    expect(
      checkToolCall('Bash', { command: 'cat /state/zq7home/git-hooks/gh-write-keys/ag000001' }, ctx),
    ).toBe(REASONS.protectedPath)
  })
})
