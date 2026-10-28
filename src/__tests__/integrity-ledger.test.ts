import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HUMAN_ROOT, IntegrityLedger } from '../broker/integrity-ledger.js'
import type { FileRecord, Records } from '../leak-guard/integrity/record.js'

/** TP-4256 A2: the broker's write-once ledger of startup and session records. All paths are synthetic. */

const ZSHENV = '/home/example/.zshenv'
const SNAPSHOT = '/home/example/.claude/shell-snapshots/snapshot-zsh-1.sh'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const present = (kind: 'startup' | 'session', ino: string, sha256 = 'h1'): FileRecord => ({
  kind,
  state: 'present',
  lstat: { dev: '1', ino, size: '10', ctimeNs: '100' },
  stat: { dev: '1', ino, size: '10', ctimeNs: '100' },
  sha256,
})

const startup: Records = { [ZSHENV]: present('startup', '7') }
const clean = (snapshot = present('session', '9')): Records => ({ ...startup, [SNAPSHOT]: snapshot })

function launched(): { ledger: IntegrityLedger; nonce: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integrity-ledger-'))
  dirs.push(dir)
  const settings = path.join(dir, 'settings.json')
  fs.writeFileSync(settings, '{}')
  const ledger = new IntegrityLedger()
  const { nonce } = ledger.admit({ agentId: 'a1', parent: HUMAN_ROOT }, () => ({
    startup,
    files: [settings],
  }))
  return { ledger, nonce }
}

describe('IntegrityLedger', () => {
  it('denies a nonce it never minted, with no baseline', () => {
    const { ledger } = launched()

    const result = ledger.check('a'.repeat(64), 's1', clean())

    expect(result).toEqual({ ok: false, reason: 'no baseline' })
  })

  it('allows a clean first check and a clean second one', () => {
    const { ledger, nonce } = launched()

    const first = ledger.check(nonce, 's1', clean())
    const second = ledger.check(nonce, 's1', clean())

    expect([first, second]).toEqual([{ ok: true }, { ok: true }])
  })

  it('denies a changed startup file and names it', () => {
    const { ledger, nonce } = launched()
    const changed = { ...clean(), [ZSHENV]: present('startup', '7', 'h2') }

    const result = ledger.check(nonce, 's1', changed)

    expect(result).toMatchObject({ ok: false, reason: 'changed', file: ZSHENV, field: 'sha256' })
  })

  it('keeps the first session record, so a second first-seen for the session is ignored', () => {
    const { ledger, nonce } = launched()
    ledger.check(nonce, 's1', clean())
    const replaced = clean(present('session', '12'))

    const result = ledger.check(nonce, 's1', replaced)

    expect(result).toMatchObject({ ok: false, file: SNAPSHOT, field: 'ino' })
  })

  it('holds a separate session record per session under one nonce', () => {
    const { ledger, nonce } = launched()
    ledger.check(nonce, 's1', clean())

    const result = ledger.check(nonce, 's2', clean(present('session', '12')))

    expect(result).toEqual({ ok: true })
  })

  it('still denies a clean record after a mismatch, naming the first change', () => {
    const { ledger, nonce } = launched()
    ledger.check(nonce, 's1', clean())
    ledger.check(nonce, 's1', clean(present('session', '9', 'h2')))

    const after = ledger.check(nonce, 's1', clean())

    expect(after).toEqual({
      ok: false,
      reason: 'quarantined',
      principal: 'a1',
      file: SNAPSHOT,
      field: 'sha256',
    })
  })

  it("TP-4345 S3: latches a first admit on a skipped ancestor's record, and a later relaunch keeps a human clear", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integrity-ledger-'))
    dirs.push(dir)
    const settings = path.join(dir, 'settings.json')
    fs.writeFileSync(settings, '{}')
    const ledger = new IntegrityLedger()
    const write = () => ({ startup, files: [settings] })
    const recorded = { file: '/synthetic/settings.json', field: 'sha256' }

    ledger.admit({ agentId: 'a2', parent: HUMAN_ROOT, recorded }, write)
    const latched = ledger.verdict('a2')
    ledger.admit({ agentId: 'a2', parent: HUMAN_ROOT, humanProof: true }, write)
    ledger.admit({ agentId: 'a2', parent: HUMAN_ROOT, recorded }, write)

    expect(latched).toMatchObject({ ok: false, reason: 'quarantined', ...recorded })
    expect(ledger.verdict('a2')).toEqual({ ok: true })
  })
})
