import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brokerKeyFor, helloProof, ownKey, proofMatches } from '../broker/launcher-key.js'
import { ensureToken } from '../broker/token.js'
import { launcherKeyPath, ownLauncherKeyPath } from '../paths.js'

/**
 * CC-1063: the launcher's hello proof. A proof that ignored the nonce could be
 * replayed by anyone who saw one hello; a host name that resolved as a path
 * could point the broker at any file the account can read.
 */

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)
const NONCE = 'n1'

let dir: string
let savedHome: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-launcher-key-'))
  savedHome = process.env.AGENT_CHAT_HOME
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = savedHome
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('proofMatches', () => {
  it('accepts the proof for the same key, host and nonce, whatever the host case', () => {
    const proof = helloProof(KEY, 'Mac.local', NONCE)

    expect(proofMatches(KEY, 'mac.local', NONCE, proof)).toBe(true)
  })

  it('refuses a proof made over another nonce, so a captured hello cannot be replayed', () => {
    const proof = helloProof(KEY, 'mac', 'n0')

    expect(proofMatches(KEY, 'mac', NONCE, proof)).toBe(false)
  })

  it('refuses a proof made for another host', () => {
    expect(proofMatches(KEY, 'mac', NONCE, helloProof(KEY, 'linux', NONCE))).toBe(false)
  })

  it('refuses a proof made with another key', () => {
    expect(proofMatches(KEY, 'mac', NONCE, helloProof(OTHER_KEY, 'mac', NONCE))).toBe(false)
  })

  it('refuses a missing, non-string or truncated proof', () => {
    const proof = helloProof(KEY, 'mac', NONCE)

    expect(proofMatches(KEY, 'mac', NONCE, undefined)).toBe(false)
    expect(proofMatches(KEY, 'mac', NONCE, 42)).toBe(false)
    expect(proofMatches(KEY, 'mac', NONCE, proof.slice(0, -1))).toBe(false)
    expect(proofMatches(KEY, 'mac', NONCE, '')).toBe(false)
  })
})

describe('launcherKeyPath', () => {
  it('refuses a host name that would resolve outside the keys directory', () => {
    expect(() => launcherKeyPath('../x')).toThrow()
    expect(() => launcherKeyPath('a/b')).toThrow()
    expect(() => launcherKeyPath('..')).toThrow()
    expect(() => launcherKeyPath('')).toThrow()
  })

  it('keys the file by the lowercased host name', () => {
    expect(launcherKeyPath('Mac.Local')).toBe(path.join(dir, 'launcher-keys', 'mac.local.key'))
  })
})

describe('key files', () => {
  it('mints a broker key 0600, so no other local account can read it', () => {
    const file = launcherKeyPath('mac')

    ensureToken(file)

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reads the broker key for a host, and none for a host never provisioned or path-like', () => {
    const key = ensureToken(launcherKeyPath('mac'))

    expect(brokerKeyFor('MAC')).toBe(key)
    expect(brokerKeyFor('linux')).toBeNull()
    expect(brokerKeyFor('../mac')).toBeNull()
  })

  it("reads the launcher's own key, and treats a blank file as absent", () => {
    expect(ownKey()).toBeNull()
    fs.writeFileSync(ownLauncherKeyPath(), '\n', { mode: 0o600 })
    expect(ownKey()).toBeNull()

    fs.writeFileSync(ownLauncherKeyPath(), `${KEY}\n`, { mode: 0o600 })
    expect(ownKey()).toBe(KEY)
  })
})
