import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { home } from '../paths.js'

describe('test environment', () => {
  it('resolves the state dir outside the real ~/.agent-chat', () => {
    expect(home()).not.toBe(path.join(os.homedir(), '.agent-chat'))
    expect(path.relative(os.tmpdir(), home()).startsWith('..')).toBe(false)
  })
})
