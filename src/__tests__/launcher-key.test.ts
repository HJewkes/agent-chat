import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brokerKeyFor, ensureBrokerKey, helloProof, ownKey, proofMatches } from '../broker/launcher-key.js'
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

  it('returns false rather than throwing for a 64-char non-ASCII proof', () => {
    expect(proofMatches(KEY, 'mac', NONCE, 'é'.repeat(64))).toBe(false)
  })

  it('refuses a 64-char proof that is not lowercase hex', () => {
    expect(proofMatches(KEY, 'mac', NONCE, 'z'.repeat(64))).toBe(false)
    expect(proofMatches(KEY, 'mac', NONCE, helloProof(KEY, 'mac', NONCE).toUpperCase())).toBe(false)
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
  it('mints a broker key 0600 in a 0700 directory, so no other local account can read it', () => {
    ensureBrokerKey('mac')

    expect(fs.statSync(launcherKeyPath('mac')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(dir, 'launcher-keys')).mode & 0o777).toBe(0o700)
  })

  it('tightens an existing keys directory to 0700 and keeps an existing key', () => {
    fs.mkdirSync(path.join(dir, 'launcher-keys'), { mode: 0o755 })
    const key = ensureBrokerKey('mac')

    expect(ensureBrokerKey('mac')).toBe(key)
    expect(fs.statSync(path.join(dir, 'launcher-keys')).mode & 0o777).toBe(0o700)
  })

  it('reads the broker key for a host, and none for a host never provisioned or path-like', () => {
    const key = ensureBrokerKey('mac')

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

  it('refuses a key file readable by group or other', () => {
    fs.writeFileSync(ownLauncherKeyPath(), `${KEY}\n`)
    fs.chmodSync(ownLauncherKeyPath(), 0o640)

    expect(ownKey()).toBeNull()
  })

  it('refuses a symlinked key file, even one pointing at a 0600 key', () => {
    const real = path.join(dir, 'elsewhere.key')
    fs.writeFileSync(real, `${KEY}\n`, { mode: 0o600 })
    fs.chmodSync(real, 0o600)
    fs.mkdirSync(path.join(dir, 'launcher-keys'), { mode: 0o700 })
    fs.symlinkSync(real, ownLauncherKeyPath())
    fs.symlinkSync(real, launcherKeyPath('mac'))

    expect(ownKey()).toBeNull()
    expect(brokerKeyFor('mac')).toBeNull()
  })
})
