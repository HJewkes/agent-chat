import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { POLL_SESSION_ID } from '@titan-design/anthropic-account'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountsBudget } from '../agents/account-budget.js'
import type { BudgetRead } from '../agents/budget.js'
import type { AccountReading } from '../agents/burndown/budget-gate.js'
import type { CharterPool } from '../agents/burndown/policy.js'
import { charterAccounts, poolStatusLines } from '../agents/burndown/tick.js'
import { paceLines, poolPaces } from '../agents/seats/status.js'

/**
 * CC-1289 e: two charter pools whose config dirs log in to one Anthropic account report as one
 * row naming both, and warn when their stops differ. Every home, login and reading is synthetic.
 */

const NOW = new Date(2026, 9, 14, 12, 0)
const NOW_S = NOW.getTime() / 1000

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-reports-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const profile = (name: string): string => path.join(home, '.claude-profiles', name)

/** A `.claude.json` holding a login; the email differs per file so only the uuids can join them. */
function writeLogin(file: string, accountUuid: string, organizationUuid = 'org-1'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const oauthAccount = { accountUuid, organizationUuid, emailAddress: `${path.basename(file)}@example.test` }
  fs.writeFileSync(file, JSON.stringify({ oauthAccount }))
}

const pool = (configDir: string, perDay: number, ceiling = 95): CharterPool => ({
  config_dir: configDir,
  human_uses: false,
  reserve_seven_day: 14,
  ceiling_five_hour: ceiling,
  per_day_points: perDay,
})

const rulesOf = (perDay: [number, number], ceiling: [number, number] = [95, 95]) => ({
  claude: pool('~/.claude', perDay[0], ceiling[0]),
  personal: pool('~/.claude-profiles/personal', perDay[1], ceiling[1]),
})

const sameLogin = () => {
  writeLogin(path.join(home, '.claude.json'), 'acct-1')
  writeLogin(path.join(profile('personal'), '.claude.json'), 'acct-1')
}

describe('burndown status pool lines', () => {
  const reading: AccountReading = { sevenDay: 20, fiveHour: 10, ageSeconds: 30 }
  const lines = (rules: Record<string, CharterPool>) =>
    poolStatusLines({ rules }, new Map([['claude', reading]]), NOW, charterAccounts(rules, home))

  it('prints one line for two pools on one login and warns on each stop they set differently', () => {
    sameLogin()

    const out = lines(rulesOf([30, 60], [100, 95]))

    expect(out.filter(l => l.startsWith('account '))).toEqual([
      expect.stringMatching(/^account claude \(\+personal\): /),
    ])
    expect(out).toContain('pools claude, personal share one account but set per_day_points 30 vs 60')
    expect(out).toContain('pools claude, personal share one account but set ceiling_five_hour 100 vs 95')
    expect(out.some(l => l.includes('reserve_seven_day'))).toBe(false)
  })

  it('prints no warning when the pools on one login set the same stops', () => {
    sameLogin()

    const out = lines(rulesOf([30, 30]))

    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^account claude \(\+personal\): /)
  })

  it('prints two lines and no warning for two logins', () => {
    writeLogin(path.join(home, '.claude.json'), 'acct-1')
    writeLogin(path.join(profile('personal'), '.claude.json'), 'acct-2')

    const out = lines(rulesOf([30, 60]))

    expect(out.map(l => l.split(':')[0])).toEqual(['account claude', 'account personal'])
  })

  it('keeps a pool whose login cannot be read as its own line', () => {
    writeLogin(path.join(home, '.claude.json'), 'acct-1')

    const out = lines(rulesOf([30, 60]))

    expect(out.map(l => l.split(':')[0])).toEqual(['account claude', 'account personal'])
  })
})

describe('seats status pace block', () => {
  const found = (configDir: string): BudgetRead => ({
    found: true,
    path: path.join(configDir, 'status.json'),
    age_seconds: 30,
    stale: false,
    budget: {
      session_id: 's',
      written_at: NOW_S - 30,
      rate_limits: {
        five_hour: { used_pct: 21, resets_at: NOW_S + 3600 },
        seven_day: { used_pct: 16, resets_at: NOW_S + 3 * 86_400 },
      },
    } as unknown as Extract<BudgetRead, { found: true }>['budget'],
  })
  const reads: string[] = []
  const deps = () => ({
    homeDir: home,
    readBudget: (dir: string) => {
      reads.push(dir)
      return found(dir)
    },
  })

  beforeEach(() => {
    reads.length = 0
  })

  it('carries one row for two pools on one login, naming the members and their differing stops', () => {
    sameLogin()

    const pace = poolPaces(deps(), rulesOf([30, 60]), NOW)

    expect(pace).toHaveLength(1)
    expect(pace[0]).toMatchObject({ pool: 'claude', members: ['claude', 'personal'], sevenDay: 16 })
    expect(reads).toEqual([path.join(home, '.claude')])
    const rendered = paceLines({ at: NOW.toISOString(), pace })
    expect(rendered[0]).toMatch(/^pace +claude \(\+personal\): 16 \| target /)
    expect(rendered[1]).toContain(
      'WARNING pools claude, personal share one account but set per_day_points 30 vs 60',
    )
  })

  it('carries two rows without members for two logins', () => {
    writeLogin(path.join(home, '.claude.json'), 'acct-1')
    writeLogin(path.join(profile('personal'), '.claude.json'), 'acct-2')

    const pace = poolPaces(deps(), rulesOf([30, 60]), NOW)

    expect(pace.map(row => row.pool)).toEqual(['claude', 'personal'])
    expect(pace.every(row => row.members === undefined && row.warnings === undefined)).toBe(true)
  })
})

describe('agent budget --accounts', () => {
  function writeReading(dir: string, ageSeconds: number, sevenDay: number): void {
    const cache = path.join(dir, 'status-cache', 'sessions')
    fs.mkdirSync(cache, { recursive: true })
    const doc = {
      session_id: POLL_SESSION_ID,
      written_at: NOW_S - ageSeconds,
      rate_limits: {
        five_hour: { used_percentage: 21, resets_at: NOW_S + 3600 },
        seven_day: { used_percentage: sevenDay, resets_at: NOW_S + 86_400 },
      },
    }
    fs.writeFileSync(path.join(cache, `${POLL_SESSION_ID}.json`), JSON.stringify(doc))
  }

  beforeEach(() => {
    fs.mkdirSync(path.join(home, '.claude'))
    for (const name of ['personal', 'work', 'nologin']) fs.mkdirSync(profile(name), { recursive: true })
    sameLogin()
    writeLogin(path.join(profile('work'), '.claude.json'), 'acct-2')
    writeReading(path.join(home, '.claude'), 90, 15)
    writeReading(profile('personal'), 30, 16)
  })

  const options = () => ({ home, env: {}, now: NOW.getTime(), pollerLog: path.join(home, 'absent.log') })

  it('prints one row per login naming its config dirs, with the freshest reading', () => {
    const report = accountsBudget(false, options())

    expect(report.lines.map(l => l.split(' ')[0])).toEqual(['default', 'nologin', 'work'])
    expect(report.lines[0]).toMatch(
      /^default \(\+personal\) +five_hour 21% .* seven_day 16% .* 30s old via usage-poller/,
    )
  })

  it('gives each JSON row the config dirs that log in to it', () => {
    const rows = JSON.parse(accountsBudget(true, options()).lines[0] ?? '') as Array<Record<string, unknown>>

    expect(rows.map(r => r.config_dirs)).toEqual([
      [path.join(home, '.claude'), profile('personal')],
      [profile('nologin')],
      [profile('work')],
    ])
    expect(rows[0]).toMatchObject({
      account: 'default',
      config_dir: path.join(home, '.claude'),
      age_seconds: 30,
    })
  })
})
