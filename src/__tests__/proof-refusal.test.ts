import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brokerKeyFor, helloProof } from '../broker/launcher-key.js'
import { proofRefusal } from '../broker/socket.js'

/**
 * CC-1317: under hostProof enforce, every host needs its broker key and a proof over this
 * connection's nonce, whether or not the machines list names it. Configured and unconfigured
 * hosts differ only in name here, since `machines` bounds names before the proof is checked.
 */

const KEY = 'a'.repeat(64)
const NONCE = 'nonce-1'
const CONFIGURED = 'owners-mac.invalid'
const UNCONFIGURED = 'stray-host.invalid'

const keyed = (): string | null => KEY
const keyless = (): string | null => null

describe.each([
  ['a configured', CONFIGURED],
  ['an unconfigured', UNCONFIGURED],
])('the proof for %s host', (_label, host) => {
  it('is refused naming the provisioning step when the broker has no key', () => {
    expect(proofRefusal(host, helloProof(KEY, host, NONCE), NONCE, keyless)).toContain(
      'provision the launcher key',
    )
  })

  it('is refused naming the provisioning step when the broker has no key and no proof was sent', () => {
    expect(proofRefusal(host, undefined, undefined, keyless)).toContain('provision the launcher key')
  })

  it('is accepted with a valid proof over this nonce', () => {
    expect(proofRefusal(host, helloProof(KEY, host, NONCE), NONCE, keyed)).toBeUndefined()
  })

  it('is refused with a proof made from the wrong key', () => {
    expect(proofRefusal(host, helloProof('f'.repeat(64), host, NONCE), NONCE, keyed)).toContain(
      'no valid launcher proof',
    )
  })

  it('is refused when no challenge preceded the hello', () => {
    expect(proofRefusal(host, helloProof(KEY, host, ''), undefined, keyed)).toContain(
      'send host_challenge first',
    )
  })
})

describe('the proof for a path-like host with the broker’s real key lookup', () => {
  let home: string | undefined

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    if (home !== undefined) fs.rmSync(home, { recursive: true, force: true })
  })

  it('is refused rather than throwing', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-proof-'))
    process.env.AGENT_CHAT_HOME = home

    expect(proofRefusal('../x', helloProof(KEY, '../x', NONCE), NONCE, brokerKeyFor)).toContain(
      'provision the launcher key',
    )
  })
})
