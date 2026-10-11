import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { knownConfigDirs, readSessionRecords } from '../agents/claude-sessions.js'

let home: string

const writeSession = (configDir: string, file: string, body: string): void => {
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'sessions', file), body)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('Claude Code session records', () => {
  it('reads pid and session id from every account dir, skipping files it cannot parse', () => {
    const defaultDir = path.join(home, '.claude')
    const profile = path.join(home, '.claude-profiles', 'work')
    writeSession(defaultDir, '101.json', JSON.stringify({ pid: 101, sessionId: 'sess-a', cwd: '/tmp' }))
    writeSession(defaultDir, '102.json', '{not json')
    writeSession(defaultDir, '103.key', 'opaque')
    writeSession(profile, '202.json', JSON.stringify({ pid: 202, sessionId: 'sess-b' }))

    const records = readSessionRecords(knownConfigDirs({}, home))

    expect(records).toEqual(
      expect.arrayContaining([
        { pid: 101, sessionId: 'sess-a' },
        { pid: 202, sessionId: 'sess-b' },
      ]),
    )
    expect(records).toHaveLength(2)
  })

  it('reads nothing when no account dir has a sessions folder', () => {
    expect(readSessionRecords(knownConfigDirs({}, home))).toEqual([])
  })
})
