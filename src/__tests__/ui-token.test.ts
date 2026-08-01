import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureToken, readToken } from '../broker/token.js'

/**
 * The loopback token, which exists for one reason: the unix socket is 0600 so the
 * trust boundary is the OS account, and a TCP port on 127.0.0.1 is reachable by
 * ANY local account. The file mode is not hygiene here — it IS the mechanism, so
 * it is asserted rather than assumed.
 */

const tmpDirs: string[] = []

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-token-'))
  tmpDirs.push(dir)
  return path.join(dir, 'ui.token')
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('ensureToken', () => {
  it('mints a token 0600, so no other local account can read it', () => {
    const file = tmpFile()
    const token = ensureToken(file)

    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  /**
   * A restart must not invalidate the token a browser tab was handed at page
   * load — that tab would 403 until someone thought to reload it.
   */
  it('reuses an existing token rather than rotating on every start', () => {
    const file = tmpFile()
    expect(ensureToken(file)).toBe(ensureToken(file))
  })

  it('creates the parent directory, since first start may precede it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-token-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'nested', 'ui.token')

    expect(ensureToken(file)).toHaveLength(64)
    expect(fs.existsSync(file)).toBe(true)
  })

  /**
   * An empty string would compare equal to a missing header and silently turn the
   * auth off — the one failure mode that must not be quiet.
   */
  it('replaces a truncated file instead of adopting an empty token', () => {
    const file = tmpFile()
    fs.writeFileSync(file, '   \n')

    expect(readToken(file)).toBeNull()
    expect(ensureToken(file)).toHaveLength(64)
  })
})

describe('readToken', () => {
  it('returns null when there is no file, rather than throwing at startup', () => {
    expect(readToken(tmpFile())).toBeNull()
  })

  it('strips the trailing newline, so a shell `cat` of the file matches the header', () => {
    const file = tmpFile()
    const token = ensureToken(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(`${token}\n`)
    expect(readToken(file)).toBe(token)
  })
})
