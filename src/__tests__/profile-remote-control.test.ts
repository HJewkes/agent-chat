import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProfile } from '../agents/profiles.js'

const dirs: string[] = []

function load(body: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-profile-'))
  dirs.push(dir)
  const base = { model: 'opus', allowedTools: ['Read'], isolation: 'none', surface: 'iterm-pane' }
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ ...base, ...body }))
  return loadProfile('p', dir)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the remoteControl profile field (CC-924)', () => {
  it('loads on a coordinator profile', () => {
    expect(load({ role: 'coordinator', remoteControl: true })).toMatchObject({ remoteControl: true })
  })

  it('refuses a worker profile that sets it, and one with no role', () => {
    expect(load({ role: 'worker', remoteControl: true })).toMatchObject({
      error: expect.stringMatching(/"remoteControl" needs "role": "coordinator"/),
    })
    expect(load({ remoteControl: true })).toHaveProperty('error')
  })

  it('refuses a value that is not a boolean', () => {
    expect(load({ role: 'coordinator', remoteControl: 'yes' })).toMatchObject({
      error: expect.stringMatching(/"remoteControl" must be true or false/),
    })
  })

  it('accepts false on a worker, and leaves it off the loaded profile', () => {
    const profile = load({ role: 'worker', remoteControl: false })
    expect(profile).not.toHaveProperty('error')
    expect(profile).not.toHaveProperty('remoteControl')
  })
})
