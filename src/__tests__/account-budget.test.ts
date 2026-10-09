import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProgram } from '../cli/index.js'
import { accountDirs, accountsBudget, readAccountUsage } from '../agents/account-budget.js'

/** A fake home with a default account and three profiles, so nothing reads a real config dir. */
let home: string
let pollerLog: string
const NOW_S = 1_800_000_000
const NOW = NOW_S * 1000

const cache = (dir: string): string => path.join(dir, 'status-cache', 'sessions')
const profile = (name: string): string => path.join(home, '.claude-profiles', name)

function writeReading(dir: string, sessionId: string, writtenAt: number, five: number, seven: number): void {
  fs.mkdirSync(cache(dir), { recursive: true })
  const doc = {
    session_id: sessionId,
    written_at: writtenAt,
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: seven, resets_at: NOW_S + 86_400 },
    },
  }
  fs.writeFileSync(path.join(cache(dir), `${sessionId}.json`), JSON.stringify(doc))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-budget-'))
  pollerLog = path.join(home, 'poller.log')
  fs.mkdirSync(path.join(home, '.claude'))
  for (const name of ['alpha', 'beta', 'gamma']) fs.mkdirSync(profile(name), { recursive: true })
  writeReading(profile('alpha'), 'usage-poller', NOW_S - 30, 55, 36)
  writeReading(profile('alpha'), 'session-1', NOW_S - 5, 99, 99)
  writeReading(profile('beta'), 'session-2', NOW_S - 10, 12, 40)
  writeReading(profile('gamma'), 'usage-poller', NOW_S - 7200, 3, 94)
  fs.writeFileSync(
    pollerLog,
    [
      '2027-01-15T07:00:00Z AUTH-FAIL alpha: no OAuth token',
      '2027-01-15T07:02:00Z ok alpha [55,36]',
      '2027-01-15T07:02:00Z AUTH-FAIL gamma: no OAuth token in credentials',
      '',
    ].join('\n'),
  )
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const options = () => ({ home, env: {}, now: NOW, pollerLog })

describe('accountDirs', () => {
  it('lists the default config dir then every profile dir', () => {
    expect(accountDirs(home, {})).toEqual([
      path.join(home, '.claude'),
      profile('alpha'),
      profile('beta'),
      profile('gamma'),
    ])
  })
})

describe('readAccountUsage', () => {
  it('prefers the usage poller cache over a fresher status-line reading', () => {
    const usage = readAccountUsage(profile('alpha'), options())
    expect(usage).toMatchObject({
      account: 'alpha',
      source: 'usage-poller',
      five_hour: { used_pct: 55, resets_at: NOW_S + 3600 },
      seven_day: { used_pct: 36, resets_at: NOW_S + 86_400 },
      age_seconds: 30,
      stale: false,
      auth_fail: false,
    })
  })

  it('falls back to the freshest status-line reading when the poller wrote nothing', () => {
    const usage = readAccountUsage(profile('beta'), options())
    expect(usage).toMatchObject({ source: 'status-line', five_hour: { used_pct: 12 }, age_seconds: 10 })
  })

  it('marks an old poller reading stale and an account whose last poll failed auth', () => {
    const usage = readAccountUsage(profile('gamma'), options())
    expect(usage).toMatchObject({ stale: true, auth_fail: true, age_seconds: 7200 })
  })

  it('reports no reading for an account with an empty cache', () => {
    const usage = readAccountUsage(path.join(home, '.claude'), options())
    expect(usage).toMatchObject({ account: 'default', source: null, five_hour: null, seven_day: null })
  })
})

describe('accountsBudget', () => {
  it('prints one line per account with both windows, resets and reading age', () => {
    const report = accountsBudget(false, options())
    expect(report.ok).toBe(true)
    expect(report.lines).toHaveLength(4)
    const alpha = report.lines.find(l => l.startsWith('alpha')) ?? ''
    expect(alpha).toContain('five_hour 55%')
    expect(alpha).toContain('seven_day 36%')
    expect(alpha).toContain(new Date((NOW_S + 3600) * 1000).toISOString())
    expect(alpha).toContain('30s old')
    expect(alpha).toContain('usage-poller')
    const gamma = report.lines.find(l => l.startsWith('gamma')) ?? ''
    expect(gamma).toContain('STALE')
    expect(gamma).toContain('AUTH-FAIL')
    expect(report.lines.find(l => l.startsWith('default'))).toContain('no reading')
  })

  it('emits the same rows as one JSON array under --json', () => {
    const report = accountsBudget(true, options())
    expect(report.lines).toHaveLength(1)
    const rows = JSON.parse(report.lines[0] ?? '') as Array<Record<string, unknown>>
    expect(rows.map(r => r.account)).toEqual(['default', 'alpha', 'beta', 'gamma'])
    expect(rows[3]).toMatchObject({ stale: true, auth_fail: true, source: 'usage-poller' })
    expect(rows[1]).toMatchObject({ five_hour: { used_pct: 55, resets_at: NOW_S + 3600 } })
  })

  it('treats a missing poller log as no auth failures', () => {
    const report = accountsBudget(true, { ...options(), pollerLog: path.join(home, 'absent.log') })
    const rows = JSON.parse(report.lines[0] ?? '') as Array<Record<string, unknown>>
    expect(rows.every(r => r.auth_fail === false)).toBe(true)
  })
})

describe('the CLI surface', () => {
  it('offers --accounts and --json on agent budget', () => {
    const agent = buildProgram().commands.find(c => c.name() === 'agent') as Command
    const budget = agent.commands.find(c => c.name() === 'budget') as Command
    const flags = budget.options.map(o => o.long)
    expect(flags).toContain('--accounts')
    expect(flags).toContain('--json')
  })
})
