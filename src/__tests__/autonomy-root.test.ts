import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autonomyRoot } from '../agents/autonomy-root.js'
import { defaultAutonomyRoot as policyRoot } from '../agents/burndown/policy.js'
import { seatPrefixes } from '../agents/pane-sources.js'
import { defaultAutonomyRoot, isWatchedSeat } from '../agents/seats/io.js'

describe('autonomyRoot', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-root-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const document = (body: unknown): string => {
    const file = path.join(dir, 'coordinator.json')
    fs.writeFileSync(file, JSON.stringify(body))
    return file
  }
  const fallback = path.join('/tmp/aw', 'claude-channels', 'sources', 'autonomy')

  it('is the active-work autonomy directory when no coordinatorConfig is set', () => {
    expect(autonomyRoot({}, { ACTIVE_ROOT: '/tmp/aw' })).toBe(fallback)
  })

  it('is the document state_dir when coordinatorConfig names one', () => {
    const coordinatorConfig = document({ state_dir: '/tmp/x' })
    expect(autonomyRoot({ coordinatorConfig }, { ACTIVE_ROOT: '/tmp/aw' })).toBe('/tmp/x')
  })

  it('keeps the default path when the document state_dir is null', () => {
    const coordinatorConfig = document({ state_dir: null })
    expect(autonomyRoot({ coordinatorConfig }, { ACTIVE_ROOT: '/tmp/aw' })).toBe(fallback)
  })

  it('uses an explicit active-work root over the environment', () => {
    expect(autonomyRoot({}, { ACTIVE_ROOT: '/tmp/aw' }, '/tmp/other')).toBe(
      path.join('/tmp/other', 'claude-channels', 'sources', 'autonomy'),
    )
  })

  it('refuses an unreadable document instead of falling back', () => {
    const coordinatorConfig = path.join(dir, 'missing.json')
    expect(() => autonomyRoot({ coordinatorConfig }, {})).toThrow(/coordinatorConfig/)
  })
})

describe('currentAutonomyRoot through the config file', () => {
  const home = process.env.AGENT_CHAT_HOME as string
  const configFile = path.join(home, 'config.json')
  afterEach(() => fs.rmSync(configFile, { force: true }))

  it('follows config.json coordinatorConfig state_dir in every reader', () => {
    const doc = path.join(home, 'coordinator.json')
    fs.writeFileSync(doc, JSON.stringify({ state_dir: '/tmp/x' }))
    fs.writeFileSync(configFile, JSON.stringify({ coordinatorConfig: doc }))
    expect(defaultAutonomyRoot()).toBe('/tmp/x')
    expect(policyRoot('/tmp/aw')).toBe('/tmp/x')
  })

  it('degrades to a seatless root when the document is unreadable', () => {
    fs.writeFileSync(configFile, JSON.stringify({ coordinatorConfig: path.join(home, 'missing.json') }))
    expect(() => defaultAutonomyRoot()).not.toThrow()
    expect(seatPrefixes()).toEqual([])
    expect(isWatchedSeat('anyone')).toBe(false)
  })

  it('rejects a relative state_dir and a relative document path', () => {
    const doc = path.join(home, 'rel.json')
    fs.writeFileSync(doc, JSON.stringify({ state_dir: 'rel/dir' }))
    expect(() => autonomyRoot({ coordinatorConfig: doc }, {})).toThrow(/absolute/)
    expect(() => autonomyRoot({ coordinatorConfig: 'rel.json' }, {})).toThrow(/absolute/)
  })
})
