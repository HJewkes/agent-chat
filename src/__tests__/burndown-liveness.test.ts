import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, readLedger, writeLedger, type Ledger } from '../agents/burndown/ledger.js'
import {
  LIVENESS_LIMIT,
  LIVENESS_TTL_MS,
  clearLiveness,
  factFingerprint,
  pruneLiveness,
  spend,
} from '../agents/burndown/liveness.js'

const key = { taskId: 'T-1' }
const t0 = new Date('2026-01-01T00:00:00.000Z')
const brief = (extra: { done_when?: string; notes?: string; stamp?: string } = {}) =>
  [
    'id: T-1',
    'updated: 2026-01-01T00:00:00Z',
    'done_at: 2026-01-01T00:00:00Z',
    `done_when: ${extra.done_when ?? 'tests pass'}`,
    `notes: ${extra.notes ?? 'none'}`,
    `last: ${extra.stamp ?? '2026-01-01T00:00:00Z'}`,
  ].join('\n')
const facts = (over: Record<string, unknown> = {}) => ({
  name: 'agent-1',
  configDir: '/cfg/a',
  brief: brief(),
  ...over,
})

describe('factFingerprint', () => {
  it('is equal when only updated, created, *_at lines and ISO stamps change', () => {
    const later = brief({ stamp: '2026-02-02T09:09:09Z' }).replace(
      'updated: 2026-01-01T00:00:00Z',
      'updated: 2026-02-02T09:09:09Z\ncreated: 2025-01-01T00:00:00Z\nmade_at: 2026-03-03T00:00:00Z',
    )

    expect(factFingerprint(facts({ brief: later, name: 'agent-2', spawnedAt: 'x' }))).toBe(
      factFingerprint(facts()),
    )
  })

  it('differs when done_when, notes or configDir change', () => {
    const base = factFingerprint(facts())

    const changed = [
      factFingerprint(facts({ brief: brief({ done_when: 'docs updated' }) })),
      factFingerprint(facts({ brief: brief({ notes: 'new note' }) })),
      factFingerprint(facts({ configDir: '/cfg/b' })),
    ]

    expect(new Set([base, ...changed]).size).toBe(4)
  })
})

describe('spend', () => {
  it('parks on the third failure for one fingerprint, not the second', () => {
    let ledger: Ledger = EMPTY_LEDGER
    const verdicts = [1, 2, 3].map(() => {
      const r = spend(ledger, key, 'spawn:p', 'fp-a', 'refused', t0)
      ledger = r.ledger
      return r.verdict
    })

    expect(LIVENESS_LIMIT).toBe(3)
    expect(verdicts).toEqual(['retry', 'retry', 'park'])
  })

  it('counts a second fingerprint separately and resumes the first on return', () => {
    let ledger: Ledger = EMPTY_LEDGER
    const verdicts = ['fp-a', 'fp-a', 'fp-b', 'fp-a'].map(fp => {
      const r = spend(ledger, key, 'spawn:p', fp, 'refused', t0)
      ledger = r.ledger
      return `${r.verdict}:${r.n}`
    })

    expect(verdicts).toEqual(['retry:1', 'retry:2', 'retry:1', 'park:3'])
  })

  it('keeps the count across a claim drop and a ledger round trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-'))
    const file = path.join(dir, 'ledger.json')
    const first = spend({ ...EMPTY_LEDGER, claims: [] }, key, 'spawn:p', 'fp-a', 'refused', t0)

    writeLedger(file, { ...first.ledger, claims: [] })
    const second = spend(readLedger(file), key, 'spawn:p', 'fp-a', 'refused', t0)

    fs.rmSync(dir, { recursive: true })
    expect(second.n).toBe(2)
  })

  it('forgets the count once the action succeeds', () => {
    const spent = spend(EMPTY_LEDGER, key, 'spawn:p', 'fp-a', 'refused', t0).ledger

    const again = spend(clearLiveness(spent, key, 'spawn:p'), key, 'spawn:p', 'fp-a', 'refused', t0)

    expect(again.n).toBe(1)
  })
})

describe('pruneLiveness', () => {
  const spent = spend(EMPTY_LEDGER, key, 'spawn:p', 'fp-a', 'refused', t0).ledger

  it('keeps a record 1 ms short of 24 h after its last failure', () => {
    const at = new Date(t0.getTime() + LIVENESS_TTL_MS - 1)

    expect(Object.keys(pruneLiveness(spent, at).liveness ?? {})).toHaveLength(1)
  })

  it('drops a record 24 h and 1 ms after its last failure, with no claim held', () => {
    const at = new Date(t0.getTime() + LIVENESS_TTL_MS + 1)

    expect(pruneLiveness(spent, at).liveness).toEqual({})
  })
})
