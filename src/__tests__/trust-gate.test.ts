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

  const refusal = (version: string | undefined) =>
    trustRefusal(repo, path.join(repo, '.worktrees', 'agent'), configDir, version)

  it.each(Object.keys(VERIFIED_TRUST_RULE_VERSIONS))(
    'accepts verified release %s under a trusted repo',
    version => {
      expect(refusal(version)).toBeUndefined()
    },
  )

  it('includes 2.1.289 among the verified releases', () => {
    expect(VERIFIED_TRUST_RULE_VERSIONS).toHaveProperty('2.1.289')
  })

  it('refuses an unverified release, naming the verified set', () => {
    expect(refusal('2.1.290')).toBe(
      `installed Claude Code 2.1.290 differs from ${Object.keys(VERIFIED_TRUST_RULE_VERSIONS).join(', ')}, the releases whose trust rule this gate reproduces`,
    )
  })

  it('refuses when the version cannot be determined', () => {
    expect(refusal(undefined)).toContain('cannot determine the installed Claude Code version')
  })

  it('does not treat an inherited property name as a verified release', () => {
    expect(refusal('toString')).toContain('differs from')
  })
})
