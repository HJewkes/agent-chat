import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { home, logPath } from '../paths.js'

describe('test environment', () => {
  it('resolves the state dir outside the real ~/.agent-chat', () => {
    expect(home()).not.toBe(path.join(os.homedir(), '.agent-chat'))
    expect(path.relative(os.tmpdir(), home()).startsWith('..')).toBe(false)
  })

  it('logs the broker under the isolated home', () => {
    expect(logPath().startsWith(home())).toBe(true)
  })
})
