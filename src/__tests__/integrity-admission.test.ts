import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HUMAN_ROOT, IntegrityLedger, LaunchAdmission, type Parent } from '../broker/integrity-ledger.js'
import type { FileRecord, Mismatch, Records } from '../leak-guard/integrity/record.js'

/**
 * TP-4256 A3a: the ledger is the only admission point and quarantine belongs to the agent
 * principal. Agent ids and paths are synthetic.
 */

const ZSHRC = '/home/example/.zshrc'
const SETTINGS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } })
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const zshrc: FileRecord = {
  kind: 'startup',
  state: 'present',
  lstat: { dev: '1', ino: '5', size: '3', ctimeNs: '50' },
  sha256: 'h1',
}
const records: Records = { [ZSHRC]: zshrc }

interface AdmitOptions {
  humanProof?: boolean
  /** The bytes the launcher writes; by default the same on every launch, as a relaunch rewrites them. */
  content?: (nonce: string) => string
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integrity-admission-'))
  dirs.push(dir)
  const notices: [string, Mismatch][] = []
  const ledger = new IntegrityLedger((agentId, mismatch) => notices.push([agentId, mismatch]))
  const fileOf = (agentId: string) => path.join(dir, `${agentId}-settings.json`)
  const admit = (agentId: string, parent: Parent, options: AdmitOptions = {}) =>
    ledger.admit({ agentId, parent, humanProof: options.humanProof === true }, ({ nonce }) => {
      fs.writeFileSync(fileOf(agentId), options.content?.(nonce) ?? SETTINGS)
      return { startup: records, files: [fileOf(agentId)] }
    }).nonce
  const tamper = (agentId: string) => fs.writeFileSync(fileOf(agentId), JSON.stringify({ hooks: {} }))
  const quarantine = (agentId: string) => {
    tamper(agentId)
    ledger.watch.sweep()
  }
  const check = (nonce: string) => ledger.check(nonce, 's1', records)
  return { ledger, notices, fileOf, admit, tamper, quarantine, check }
}

describe('integrity admission: quarantine belongs to the agent, not the nonce', () => {
  it('denies the new nonce of a quarantined agent re-admitted without human proof', () => {
    const { admit, quarantine, check } = fixture()
    admit('a1', HUMAN_ROOT)
    quarantine('a1')

    const relaunched = admit('a1', HUMAN_ROOT)

    expect(check(relaunched)).toMatchObject({ ok: false, reason: 'quarantined', principal: 'a1' })
  })

  it('keeps the quarantine across a re-baseline that rewrites every launch file and startup record', () => {
    const { admit, quarantine, check, fileOf } = fixture()
    admit('a1', HUMAN_ROOT)
    quarantine('a1')

    const rebaselined = admit('a1', HUMAN_ROOT, { content: nonce => `${SETTINGS}${nonce}` })

    expect(fs.readFileSync(fileOf('a1'), 'utf8')).toContain(rebaselined)
    expect(check(rebaselined)).toMatchObject({ ok: false, reason: 'quarantined', file: fileOf('a1') })
  })

  it('clears on a human admit, but not a later latch', () => {
    const { admit, quarantine, check } = fixture()
    admit('a1', HUMAN_ROOT)
    quarantine('a1')

    const resumed = admit('a1', HUMAN_ROOT, { humanProof: true })
    const cleared = check(resumed)
    quarantine('a1')

    expect(cleared).toEqual({ ok: true })
    expect(check(resumed)).toMatchObject({ ok: false, reason: 'quarantined', principal: 'a1' })
  })

  it('files one notice per latch, naming the agent', () => {
    const { admit, quarantine, notices, fileOf } = fixture()
    admit('a1', HUMAN_ROOT)

    quarantine('a1')
    admit('a1', HUMAN_ROOT)

    expect(notices).toEqual([['a1', { file: fileOf('a1'), field: 'sha256' }]])
  })
})

describe('integrity admission: lineage', () => {
  it('denies a child admitted before its parent latched', () => {
    const { admit, quarantine, check } = fixture()
    admit('p', HUMAN_ROOT)
    const child = admit('c', 'p')

    quarantine('p')

    expect(check(child)).toMatchObject({ ok: false, reason: 'quarantined', principal: 'p' })
  })

  it('denies a child admitted after its parent latched, even once the parent is cleared', () => {
    const { admit, quarantine, check } = fixture()
    admit('p', HUMAN_ROOT)
    quarantine('p')

    const child = admit('c', 'p')
    admit('p', HUMAN_ROOT, { humanProof: true })

    expect(check(child)).toMatchObject({ ok: false, reason: 'quarantined', field: 'quarantined parent' })
  })

  it('denies a teleport successor whose predecessor is quarantined', () => {
    const { admit, quarantine, check } = fixture()
    admit('a1', HUMAN_ROOT)
    quarantine('a1')

    const successor = admit('a1-next', 'a1')

    expect(check(successor)).toMatchObject({ ok: false, reason: 'quarantined' })
  })

  it('latches an unknown parent, and the child stays denied once that parent appears', () => {
    const { ledger, admit, check } = fixture()

    const orphan = admit('c', 'p')
    const before = check(orphan)
    admit('p', HUMAN_ROOT)

    expect(before).toMatchObject({ ok: false, reason: 'quarantined', field: 'unknown parent' })
    expect(ledger.verdict('c')).toMatchObject({ ok: false, file: '<lineage>', field: 'unknown parent' })
  })

  it('denies an agent id the ledger never admitted', () => {
    const { ledger, admit } = fixture()
    admit('a1', HUMAN_ROOT)

    expect(ledger.verdict('a2')).toEqual({ ok: false, reason: 'no baseline' })
  })

  it('keeps the first parent and latches a re-admit that names another', () => {
    const { ledger, admit } = fixture()
    admit('p', HUMAN_ROOT)
    admit('c', 'p')

    admit('c', HUMAN_ROOT)

    expect(ledger.verdict('c')).toMatchObject({ ok: false, field: 'parent changed' })
  })

  it('allows a child spawned after a human cleared its parent', () => {
    const { admit, quarantine, check } = fixture()
    admit('p', HUMAN_ROOT)
    quarantine('p')
    admit('p', HUMAN_ROOT, { humanProof: true })

    const child = admit('c', 'p')

    expect(check(child)).toEqual({ ok: true })
  })
})

describe('integrity admission: the watch follows the newest launch (FF1)', () => {
  it('latches a tamper made before a relaunch rewrote the same bytes', () => {
    const { admit, tamper, check } = fixture()
    admit('a1', HUMAN_ROOT)
    tamper('a1')

    const relaunched = admit('a1', HUMAN_ROOT)

    expect(check(relaunched)).toMatchObject({ ok: false, reason: 'quarantined', field: 'sha256' })
  })

  it('raises no false quarantine from the old baselines after a clean rewrite', () => {
    const { ledger, admit, check, notices } = fixture()
    const content = (nonce: string) => `${SETTINGS}${nonce}`
    admit('a1', HUMAN_ROOT, { content })

    const relaunched = admit('a1', HUMAN_ROOT, { content })
    ledger.watch.sweep()

    expect(check(relaunched)).toEqual({ ok: true })
    expect(notices).toEqual([])
  })
})

describe('integrity admission: only admit mints', () => {
  it('denies a nonce admit never minted', () => {
    const { admit, check } = fixture()
    admit('a1', HUMAN_ROOT)

    expect(check('b'.repeat(64))).toEqual({ ok: false, reason: 'no baseline' })
  })

  it('mints a fresh 32-byte nonce per admit', () => {
    const { admit } = fixture()

    const nonces = [admit('a1', HUMAN_ROOT), admit('a1', HUMAN_ROOT)]

    expect(nonces[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(nonces[1]).not.toEqual(nonces[0])
  })

  it('refuses to construct an admission outside the ledger', () => {
    const forge = LaunchAdmission as unknown as new (...args: unknown[]) => LaunchAdmission

    expect(() => new forge(Symbol('integrity admission'), 'b'.repeat(64), 'a1')).toThrow(/only from admit/)
  })
})
