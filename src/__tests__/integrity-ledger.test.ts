import { describe, expect, it } from 'vitest'
import { IntegrityLedger } from '../broker/integrity-ledger.js'
import type { FileRecord, Records } from '../leak-guard/integrity/record.js'

/** TP-4256 A2: the broker's write-once ledger of startup and session records. All paths are synthetic. */

const NONCE = 'a'.repeat(64)
const ZSHENV = '/home/example/.zshenv'
const SNAPSHOT = '/home/example/.claude/shell-snapshots/snapshot-zsh-1.sh'

const present = (kind: 'startup' | 'session', ino: string, sha256 = 'h1'): FileRecord => ({
  kind,
  state: 'present',
  lstat: { dev: '1', ino, size: '10', ctimeNs: '100' },
  stat: { dev: '1', ino, size: '10', ctimeNs: '100' },
  sha256,
})

const startup: Records = { [ZSHENV]: present('startup', '7') }
const clean = (snapshot = present('session', '9')): Records => ({ ...startup, [SNAPSHOT]: snapshot })

function launched(): IntegrityLedger {
  const ledger = new IntegrityLedger()
  ledger.registerLaunch(NONCE, 'a1', startup)
  return ledger
}

describe('IntegrityLedger', () => {
  it('denies a nonce it never registered, with no baseline', () => {
    const ledger = new IntegrityLedger()

    const result = ledger.check(NONCE, 's1', clean())

    expect(result).toEqual({ ok: false, reason: 'no baseline' })
  })

  it('allows a clean first check and a clean second one', () => {
    const ledger = launched()

    const first = ledger.check(NONCE, 's1', clean())
    const second = ledger.check(NONCE, 's1', clean())

    expect([first, second]).toEqual([{ ok: true }, { ok: true }])
  })

  it('denies a changed startup file and names it', () => {
    const ledger = launched()
    const changed = { ...clean(), [ZSHENV]: present('startup', '7', 'h2') }

    const result = ledger.check(NONCE, 's1', changed)

    expect(result).toMatchObject({ ok: false, file: ZSHENV, field: 'sha256', latched: true })
  })

  it('keeps the first session record, so a second first-seen for the session is ignored', () => {
    const ledger = launched()
    ledger.check(NONCE, 's1', clean())
    const replaced = clean(present('session', '12'))

    const result = ledger.check(NONCE, 's1', replaced)

    expect(result).toMatchObject({ ok: false, file: SNAPSHOT, field: 'ino' })
  })

  it('holds a separate session record per session under one nonce', () => {
    const ledger = launched()
    ledger.check(NONCE, 's1', clean())

    const result = ledger.check(NONCE, 's2', clean(present('session', '12')))

    expect(result).toEqual({ ok: true })
  })

  it('still denies a clean record after a mismatch, without latching again', () => {
    const ledger = launched()
    ledger.check(NONCE, 's1', clean())
    const mismatch = ledger.check(NONCE, 's1', clean(present('session', '9', 'h2')))

    const after = ledger.check(NONCE, 's1', clean())

    expect(mismatch).toMatchObject({ ok: false, latched: true })
    expect(after).toEqual({
      ok: false,
      reason: 'quarantined',
      file: SNAPSHOT,
      field: 'sha256',
      latched: false,
    })
  })

  it('refuses to register a nonce twice', () => {
    const ledger = launched()

    expect(() => ledger.registerLaunch(NONCE, 'a2', {})).toThrow(/already registered/)
  })
})
