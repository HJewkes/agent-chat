import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionIdentityError } from '@titan-design/session-read'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observedModel, projectSlug } from '../agents/transcript.js'

/** session-read is an external package: only its reader is replaced, so the thrown error is chosen here. */
const readerThrows = vi.hoisted(() => ({ error: undefined as unknown }))

vi.mock('@titan-design/session-read', async importOriginal => ({
  ...(await importOriginal<typeof import('@titan-design/session-read')>()),
  readRecentSessionTurnsSync: () => {
    throw readerThrows.error
  },
}))

const CWD = '/work/example-project'
const SESSION = '00000000-0000-4000-8000-000000000001'
let configDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-model-identity-'))
  const dir = path.join(configDir, 'projects', projectSlug(CWD))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), '{}\n')
})

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('observedModel on a session-read identity error', () => {
  it('is undefined when session-read throws a SessionIdentityError whose message the old regex never matched', () => {
    readerThrows.error = new SessionIdentityError(
      'Claude transcript t contains session s',
      'foreign_native_session',
    )
    expect(observedModel(CWD, SESSION, configDir)).toBeUndefined()
  })

  it('rethrows a plain TypeError that only looks like an identity error', () => {
    const lookalike = new TypeError('Claude transcript record belongs to native session x, expected y')
    readerThrows.error = lookalike
    expect(() => observedModel(CWD, SESSION, configDir)).toThrow(lookalike)
  })
})
