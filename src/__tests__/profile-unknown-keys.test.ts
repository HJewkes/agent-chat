import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProfile, parseProfile } from '../agents/profiles.js'

const valid = { model: 'sonnet', allowedTools: ['Read'], isolation: 'none', surface: 'headless' }

describe('unknown profile keys', () => {
  it('warns with the file and key for a field AgentProfile does not have', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-keys-'))
    fs.writeFileSync(path.join(dir, 'typo.json'), JSON.stringify({ ...valid, deniedTools: ['Monitor'] }))

    const loaded = loadProfile('typo', dir)

    expect(loaded).toMatchObject({ name: 'typo', model: 'sonnet' })
    expect(loaded).toHaveProperty('warnings', [expect.stringMatching(/typo\.json.*"deniedTools"/)])
  })

  it('gives a valid profile no warnings', () => {
    const parsed = parseProfile('ok', { ...valid, disallowedTools: ['Monitor'], effort: 'low' })

    expect(parsed).not.toHaveProperty('warnings')
  })

  it('names every unknown key', () => {
    const parsed = parseProfile('two', { ...valid, deniedTools: [], extra: 1 })

    expect(parsed).toHaveProperty('warnings', [
      expect.stringContaining('"deniedTools"'),
      expect.stringContaining('"extra"'),
    ])
  })
})
