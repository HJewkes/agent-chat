import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountUsage } from '../agents/account-budget.js'
import {
  accountTargetCheck,
  keychainService,
  moveTranscript,
  resolveAccountTarget,
  type AccountReaders,
  type AccountTarget,
} from '../agents/account-move.js'
import { transcriptPath } from '../agents/transcript.js'

let home: string
const SESSION = '00000000-0000-4000-8000-000000000001'
const NOW = Date.UTC(2027, 0, 15, 7, 0, 0)

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-move-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const profile = (name: string): string => path.join(home, '.claude-profiles', name)
const cwd = (): string => path.join(home, 'projects', 'demo')

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    account: 'server',
    config_dir: profile('server'),
    source: 'usage-poller',
    five_hour: { used_pct: 10 },
    seven_day: { used_pct: 20 },
    age_seconds: 30,
    stale: false,
    auth_fail: false,
    ...over,
  }
}

const IDENTITIES: Record<string, string> = {
  personal: 'acct-1/org-1',
  claude: 'acct-1/org-1',
  server: 'acct-2/org-2',
}

function readers(over: Partial<AccountReaders> = {}): AccountReaders {
  return {
    identity: target => IDENTITIES[target.unset === true ? 'claude' : path.basename(target.dir)],
    usage: () => usage(),
    hasLogin: () => true,
    trusted: () => true,
    ...over,
  }
}

const personal = (): AccountTarget => ({ dir: profile('personal') })
const server = (): AccountTarget => ({ dir: profile('server') })

describe('resolveAccountTarget', () => {
  it('maps claude to the default dir with CLAUDE_CONFIG_DIR unset', () => {
    expect(resolveAccountTarget('claude', { home })).toEqual({ dir: path.join(home, '.claude'), unset: true })
  })

  it('maps a profile name to its dir under the profile root', () => {
    fs.mkdirSync(profile('server'), { recursive: true })
    expect(resolveAccountTarget('server', { home, env: {} })).toEqual({ dir: profile('server') })
  })

  it('refuses a profile whose dir does not exist', () => {
    expect(resolveAccountTarget('workout', { home, env: {} })).toHaveProperty('error')
  })

  it('refuses a config dir outside the home directory', () => {
    expect(resolveAccountTarget('/elsewhere/config', { home })).toHaveProperty('error')
  })
})

describe('keychainService', () => {
  it('names the unhashed service when CLAUDE_CONFIG_DIR is unset and a hashed one when set', () => {
    const dir = path.join(home, '.claude')
    expect(keychainService({ dir, unset: true })).toBe('Claude Code-credentials')
    expect(keychainService({ dir })).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
  })
})

describe('accountTargetCheck', () => {
  const check = (over: Partial<Parameters<typeof accountTargetCheck>[0]> = {}) =>
    accountTargetCheck({ from: personal(), to: server(), cwd: cwd(), readers: readers(), ...over })

  it('passes a fresh, trusted target on another login', () => {
    expect(check()).toEqual({ ok: true, refusals: [] })
  })

  it('refuses personal to claude when both bill the same accountUuid/organizationUuid', () => {
    const result = check({ to: { dir: path.join(home, '.claude'), unset: true } })
    expect(result.ok).toBe(false)
    expect(result.refusals.join('\n')).toMatch(/same Anthropic login/)
  })

  it('refuses five_hour at exactly the ceiling and names the figure', () => {
    const result = check({
      limits: { fiveHour: 95 },
      readers: readers({ usage: () => usage({ five_hour: { used_pct: 95 } }) }),
    })
    expect(result.ok).toBe(false)
    expect(result.refusals.join('\n')).toMatch(/five_hour 95%.*ceiling of 95%/)
  })

  it('lets force lift a five_hour refusal', () => {
    const result = check({
      force: true,
      limits: { fiveHour: 95 },
      readers: readers({ usage: () => usage({ five_hour: { used_pct: 99 } }) }),
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a stale reading, even when its figures are low', () => {
    const result = check({ readers: readers({ usage: () => usage({ stale: true, age_seconds: 900 }) }) })
    expect(result.ok).toBe(false)
    expect(result.refusals.join('\n')).toMatch(/stale \(900s old\)/)
  })

  it('refuses a target with no login', () => {
    expect(check({ readers: readers({ hasLogin: () => false }) }).ok).toBe(false)
  })

  it('refuses a cwd the target config definitely does not trust', () => {
    const result = check({ readers: readers({ trusted: () => false }) })
    expect(result.ok).toBe(false)
    expect(result.refusals.join('\n')).toMatch(/no accepted trust entry/)
  })

  it('passes when the target config cannot be read for trust', () => {
    expect(check({ readers: readers({ trusted: () => undefined }) }).ok).toBe(true)
  })

  it('reads trust for claude with CLAUDE_CONFIG_DIR unset', () => {
    const seen: (string | undefined)[] = []
    check({
      from: server(),
      to: { dir: path.join(home, '.claude'), unset: true },
      readers: readers({ trusted: (_cwd, dir) => (seen.push(dir), true) }),
    })
    expect(seen).toEqual([undefined])
  })
})

describe('moveTranscript', () => {
  const sourceFile = (): string => transcriptPath(cwd(), SESSION, profile('personal'))
  const targetFile = (): string => transcriptPath(cwd(), SESSION, profile('server'))

  function writeTranscript(file: string, text: string, mtimeMs: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, { mode: 0o644 })
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  }

  it('copies identical bytes at mode 0600 and renames the source .moved-', () => {
    const bytes = '{"type":"user","text":"synthetic"}\n'
    writeTranscript(sourceFile(), bytes, NOW)

    const result = moveTranscript({
      from: personal(),
      to: server(),
      cwd: cwd(),
      sessionId: SESSION,
      now: NOW,
    })

    expect(result).toMatchObject({ ok: true, transcript: targetFile(), bytes: bytes.length })
    expect(fs.readFileSync(targetFile(), 'utf8')).toBe(bytes)
    expect(fs.statSync(targetFile()).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(sourceFile())).toBe(false)
    const moved = `${sourceFile()}.moved-2027-01-15T07-00-00-000Z`
    expect(result.ok && result.movedSource).toBe(moved)
    expect(fs.readFileSync(moved, 'utf8')).toBe(bytes)
  })

  it('refuses when the target copy is newer, leaving both copies untouched', () => {
    writeTranscript(sourceFile(), 'old\n', NOW - 60_000)
    writeTranscript(targetFile(), 'newer\n', NOW)

    const result = moveTranscript({
      from: personal(),
      to: server(),
      cwd: cwd(),
      sessionId: SESSION,
      now: NOW,
    })

    expect(result.ok).toBe(false)
    expect(fs.readFileSync(targetFile(), 'utf8')).toBe('newer\n')
    expect(fs.readFileSync(sourceFile(), 'utf8')).toBe('old\n')
  })

  it('refuses when the source transcript is missing', () => {
    const result = moveTranscript({ from: personal(), to: server(), cwd: cwd(), sessionId: SESSION })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/no transcript/) })
  })
})
