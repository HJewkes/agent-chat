import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trustRefusal } from '../agents/burndown/trust-gate.js'
import { VERIFIED_TRUST_RULE_VERSIONS } from '../agents/trust.js'

describe('trustRefusal by CLI version', () => {
  let world: string
  let repo: string
  let configDir: string

  beforeEach(() => {
    world = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-gate-'))
    repo = path.join(fs.realpathSync(world), 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    configDir = path.join(world, 'config')
    fs.mkdirSync(configDir)
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    )
  })

  afterEach(() => fs.rmSync(world, { recursive: true, force: true }))

  const refusal = (version: string | undefined, env: NodeJS.ProcessEnv = {}) =>
    trustRefusal(repo, path.join(repo, '.worktrees', 'agent'), configDir, version, env)

  it.each(Object.keys(VERIFIED_TRUST_RULE_VERSIONS))(
    'accepts verified release %s under a trusted repo',
    version => {
      expect(refusal(version)).toBeUndefined()
    },
  )

  it('includes 2.1.289 among the verified releases', () => {
    expect(VERIFIED_TRUST_RULE_VERSIONS).toHaveProperty('2.1.289')
  })

  it('verifies 2.1.290 against 2.1.289', () => {
    expect(VERIFIED_TRUST_RULE_VERSIONS['2.1.290']).toBe('2.1.289')
    expect(refusal('2.1.290')).toBeUndefined()
  })

  it('verifies 2.1.291 against 2.1.290', () => {
    expect(VERIFIED_TRUST_RULE_VERSIONS['2.1.291']).toBe('2.1.290')
    expect(refusal('2.1.291')).toBeUndefined()
  })

  it('verifies 2.1.292 against 2.1.291', () => {
    expect(VERIFIED_TRUST_RULE_VERSIONS['2.1.292']).toBe('2.1.291')
    expect(refusal('2.1.292')).toBeUndefined()
  })

  it('verifies 2.1.296 against 2.1.295', () => {
    expect(VERIFIED_TRUST_RULE_VERSIONS['2.1.296']).toBe('2.1.295')
    expect(refusal('2.1.296')).toBeUndefined()
  })

  it('freezes the verified release map', () => {
    expect(Object.isFrozen(VERIFIED_TRUST_RULE_VERSIONS)).toBe(true)
  })

  it('refuses a verified release while CLAUDE_CODE_CUSTOM_OAUTH_URL is set', () => {
    expect(refusal('2.1.290', { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.example.test' })).toMatch(
      /CLAUDE_CODE_CUSTOM_OAUTH_URL.*trust config file/,
    )
  })

  it.each([undefined, ''])('passes when CLAUDE_CODE_CUSTOM_OAUTH_URL is %j', value => {
    expect(refusal('2.1.290', { CLAUDE_CODE_CUSTOM_OAUTH_URL: value })).toBeUndefined()
  })

  it('refuses an unverified release, naming the verified set', () => {
    expect(refusal('2.1.293')).toContain(
      `installed Claude Code 2.1.293 is not one of ${Object.keys(VERIFIED_TRUST_RULE_VERSIONS).join(', ')}`,
    )
  })

  it('refuses a release newer than every verified one, naming the owner step that vets it', () => {
    const message = refusal('2.1.999')
    expect(message).toContain('node scripts/verify-trust-rule.mjs 2.1.999')
    expect(message).toContain('docs/trust-rule-versions.md')
    expect(message).toContain('VERIFIED_TRUST_RULE_VERSIONS')
  })

  it('accepts a release once it is vetted into the verified set', () => {
    expect(refusal(Object.keys(VERIFIED_TRUST_RULE_VERSIONS).at(-1))).toBeUndefined()
  })

  it('refuses when the version cannot be determined', () => {
    expect(refusal(undefined)).toContain('cannot determine the installed Claude Code version')
  })

  it('does not treat an inherited property name as a verified release', () => {
    expect(refusal('toString')).toContain('is not one of')
  })
})
