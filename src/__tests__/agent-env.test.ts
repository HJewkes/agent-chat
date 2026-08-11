import { describe, expect, it } from 'vitest'

import { agentEnv, isSecretName } from '../agents/agent-env.js'

describe('isSecretName', () => {
  it('catches the two that were actually observed leaking', () => {
    // R-70's finding: a dispatched agent inherited the broker's whole
    // environment, these included.
    expect(isSecretName('NPM_TOKEN')).toBe(true)
    expect(isSecretName('BRIGHTDATA_API_TOKEN')).toBe(true)
  })

  it('catches credential-shaped names by pattern, not only by list', () => {
    for (const name of [
      'ACME_TOKEN',
      'SOMETHING_SECRET',
      'DB_PASSWORD',
      'VENDOR_API_KEY',
      'VENDOR_APIKEY',
      'SERVICE_PRIVATE_KEY',
      'THING_CREDENTIALS',
    ]) {
      expect(isSecretName(name), name).toBe(true)
    }
  })

  /**
   * Found by measurement, not by reading: run against a real environment the
   * end-anchored patterns caught NPM_TOKEN and let these two straight through.
   * A per-registry token is the same secret with a scope suffix, and suffixing
   * is how one credential becomes five.
   */
  it('catches a credential word in the middle, which end-anchoring alone missed', () => {
    expect(isSecretName('NPM_TOKEN_TITAN_DESIGN')).toBe(true)
    expect(isSecretName('NPM_TOKEN_VOLTRAS')).toBe(true)
  })

  /**
   * The counterweight to the rule above, and the reason AUTH is not one of the
   * segment words: stripping SSH_AUTH_SOCK would take the agent's ssh-agent
   * socket with it — no `git push` from any agent — for a variable that carries
   * a path and not a key.
   */
  it('keeps SSH_AUTH_SOCK, which carries a path rather than a key', () => {
    expect(isSecretName('SSH_AUTH_SOCK')).toBe(false)
  })

  it('sweeps cloud-identity prefixes, including the names that are not themselves secret', () => {
    // AWS_PROFILE names a credential set without being one; a process acting as
    // that identity is the thing being prevented.
    expect(isSecretName('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(isSecretName('AWS_PROFILE')).toBe(true)
    expect(isSecretName('AZURE_CLIENT_ID')).toBe(true)
  })

  /**
   * The anchoring matters: a substring match would sweep up ordinary variables
   * and break spawns for reasons nobody could see from the error.
   */
  it('leaves ordinary variables alone, including near-misses', () => {
    for (const name of [
      'PATH',
      'HOME',
      'USER',
      'LANG',
      'TERM',
      'TMPDIR',
      // First-segment names describe where a credential lives rather than
      // being one; sweeping them would break spawns for no gain.
      'TOKEN_PATH',
      'SECRET_DIR',
      'KEYBOARD_LAYOUT',
      'SECRETARY_NAME',
      'AUTHORITY',
    ]) {
      expect(isSecretName(name), name).toBe(false)
    }
  })

  /**
   * Not a hole: this is the credential the spawned binary uses to BE an agent.
   * Withholding a program's own auth is breakage, not confinement — an operator
   * who authenticates this way rather than through the Keychain has no spawn
   * without it.
   */
  it('keeps the spawned binary’s own authentication', () => {
    expect(isSecretName('ANTHROPIC_API_KEY')).toBe(false)
    expect(isSecretName('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false)
  })

  it('judges every rule on the same case-folded name', () => {
    // The exemption is checked after folding, so an oddly-cased name cannot be
    // stripped by one rule and kept by another.
    expect(isSecretName('anthropic_api_key')).toBe(false)
    expect(isSecretName('npm_token')).toBe(true)
  })
})

describe('agentEnv', () => {
  it('passes ordinary variables through and drops the credentials', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      NPM_TOKEN: 'npm_secret',
      AWS_SECRET_ACCESS_KEY: 'aws_secret',
    })

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/test' })
  })

  it('drops undefined values rather than passing them to spawn', () => {
    // process.env is typed as possibly-undefined per key, and an explicit
    // undefined is not the same thing as an absent key.
    expect(agentEnv({ PATH: '/usr/bin', EMPTY: undefined })).toEqual({
      PATH: '/usr/bin',
    })
  })

  it('reads the real environment by default without mutating it', () => {
    const before = { ...process.env }
    agentEnv()
    expect({ ...process.env }).toEqual(before)
  })
})
