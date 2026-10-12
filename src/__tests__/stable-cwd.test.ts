import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brokerCwd, existingDirOr } from '../agents/stable-cwd.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-stable-cwd-'))
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('existingDirOr', () => {
  it('keeps a directory that exists', () => {
    expect(existingDirOr(dir, '/tmp')).toBe(dir)
  })

  it('falls back when the directory is gone', () => {
    expect(existingDirOr(path.join(dir, 'nope'), '/tmp')).toBe('/tmp')
  })

  it('falls back when the path is a file, not a directory', () => {
    const file = path.join(dir, 'f')
    fs.writeFileSync(file, '')
    expect(existingDirOr(file, '/tmp')).toBe('/tmp')
  })

  it('falls back when no path is given', () => {
    expect(existingDirOr(undefined, '/tmp')).toBe('/tmp')
  })
})

describe('brokerCwd', () => {
  it('is the agent-chat home when it exists', () => {
    process.env.AGENT_CHAT_HOME = dir
    expect(brokerCwd()).toBe(dir)
  })

  it('is HOME when the agent-chat home does not exist yet', () => {
    process.env.AGENT_CHAT_HOME = path.join(dir, 'missing')
    expect(brokerCwd()).toBe(os.homedir())
  })
})
