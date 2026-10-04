import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { loadTickConfig, type TickConfig } from '../agents/burndown/source.js'
import {
  ownerDue,
  triageReadiness,
  triageVerdicts,
  type Readiness,
  type VerdictInputs,
} from '../agents/burndown/triage.js'

/** CC-649: triage readiness and the per-claim verdict, pure over a hand-built config and ledger. */

const NOW = new Date('2026-09-28T12:00:00.000Z')
const MIN = 60_000
const loads = (): object => ({ name: 'triager' })
const dirOf = (account: string): string => `/accounts/${account}`

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function configFrom(exceptions: Record<string, unknown>): TickConfig {
  const file = path.join(dir, 'burndown.config.json')
  fs.writeFileSync(file, JSON.stringify({ exceptions }))
  return loadTickConfig(file)
}

const ALL_TRIAGE = { stalled: 'triage', failed: 'triage' }

const stalled = (taskId: string, patch: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'demo',
  spawnedAt: NOW.toISOString(),
  phase: 'implementing',
  phaseAt: NOW.toISOString(),
  stalledReason: 'no final report',
  stalledClass: 'failed',
  ...patch,
})

const READY: Readiness = {
  ready: true,
  profile: 'triager',
  configDir: '/accounts/a',
  maxPerDay: 12,
  maxMinutes: 30,
}

function inputs(patch: Partial<VerdictInputs> & { claims?: Claim[] } = {}): VerdictInputs {
  const { claims = [stalled('CC-1')], ...rest } = patch
  const ledger: Ledger = { version: 1, claims }
  return {
    config: configFrom({ route: ALL_TRIAGE, triage: { account: 'a' } }),
    readiness: READY,
    ledger,
    capacity: 3,
    capacityReason: '0 of maxAgents 3 burndown agents alive',
    now: NOW,
    ...rest,
  }
}

describe('triage readiness', () => {
  it('parses a config without an account and reports that none is set', () => {
    const config = configFrom({ route: ALL_TRIAGE, triage: {} })

    expect(config.exceptions.triage).toEqual({ profile: 'triager', maxPerDay: 12, maxMinutes: 30 })
    expect(triageReadiness(config, loads, dirOf)).toEqual({
      ready: false,
      reason: 'no exceptions.triage.account set',
    })
  })

  it('is not ready without an exceptions.triage block', () => {
    const readiness = triageReadiness(configFrom({ route: ALL_TRIAGE }), loads, dirOf)

    expect(readiness).toEqual({ ready: false, reason: 'no exceptions.triage in the burndown config' })
  })

  it('names the profile that does not load', () => {
    const config = configFrom({ triage: { profile: 'missing', account: 'a' } })

    const readiness = triageReadiness(config, () => ({ error: 'no profile named "missing"' }), dirOf)

    expect(readiness).toEqual({ ready: false, reason: 'profile missing: no profile named "missing"' })
  })

  it('is ready with the account resolved to its config dir', () => {
    const config = configFrom({ triage: { account: 'a', maxPerDay: 2 } })

    expect(triageReadiness(config, loads, dirOf)).toEqual({ ...READY, maxPerDay: 2 })
  })

  it('rejects an unknown key under exceptions.triage', () => {
    expect(() => configFrom({ triage: { account: 'a', every: 5 } })).toThrow(/malformed/)
  })
})

describe('triage verdicts', () => {
  it('checks readiness before the day cap and the cap before capacity', () => {
    const spent = { triageStarts: [new Date(NOW.getTime() - MIN).toISOString()] }
    const ledger: Ledger = { version: 1, claims: [stalled('CC-1')], ...spent }
    const tight = { ...READY, maxPerDay: 1 }

    const unready = triageVerdicts(inputs({ readiness: { ready: false, reason: 'r' }, ledger, capacity: 0 }))
    const capped = triageVerdicts(inputs({ readiness: tight, ledger, capacity: 0 }))
    const full = triageVerdicts(inputs({ capacity: 0 }))

    expect(unready.map(v => [v.kind, 'reason' in v && v.reason])).toEqual([
      ['owner', 'triage is not ready: r'],
    ])
    expect(capped.map(v => [v.kind, 'reason' in v && v.reason])).toEqual([
      ['owner', 'triage day cap spent (1 of maxPerDay 1)'],
    ])
    expect(full.map(v => [v.kind, 'reason' in v && v.reason])).toEqual([
      ['wait', 'no agent capacity: 0 of maxAgents 3 burndown agents alive'],
    ])
  })

  it('does not count a start older than a day against the cap', () => {
    const old = new Date(NOW.getTime() - 25 * 60 * MIN).toISOString()
    const ledger: Ledger = { version: 1, claims: [stalled('CC-1')], triageStarts: [old] }

    const verdicts = triageVerdicts(inputs({ readiness: { ...READY, maxPerDay: 1 }, ledger }))

    expect(verdicts.map(v => v.kind)).toEqual(['start'])
  })

  it('gives no verdict to a gate-trip, a legacy row, or a claim whose job already settled', () => {
    const settled = stalled('CC-3')
    const record = { occurrence: `${NOW.toISOString()} no final report`, since: NOW.toISOString() }
    const claims = [
      stalled('CC-1', { stalledClass: 'gate-trip' }),
      stalled('CC-2', { stalledClass: undefined }),
      { ...settled, triage: { ...record, outcome: 'ended' as const, name: 'triage-cc-3-1' } },
    ]

    expect(triageVerdicts(inputs({ claims }))).toEqual([])
  })

  it('numbers the job past every triager the claim already ran', () => {
    const claims = [stalled('CC-1', { slice: 'B', spawned: ['bd-cc-1-b', 'triage-cc-1-b-1'] })]

    expect(triageVerdicts(inputs({ claims }))).toEqual([expect.objectContaining({ name: 'triage-cc-1-b-2' })])
  })
})

describe('ownerDue', () => {
  const occurrence = `${NOW.toISOString()} no final report`
  const record = { occurrence, since: NOW.toISOString() }

  it.each([
    ['no record', true, undefined],
    ['waiting', false, { ...record, outcome: 'waiting' as const }],
    ['started', false, { ...record, outcome: 'started' as const }],
    ['refused', true, { ...record, outcome: 'refused' as const }],
    ['ended', true, { ...record, outcome: 'ended' as const }],
    ['fallback', true, { ...record, outcome: 'fallback' as const }],
    ['started for an earlier stall', true, { ...record, occurrence: 'earlier', outcome: 'started' as const }],
  ])('a triage record %s gives ownerDue %s', (_name, due, triage) => {
    const claim = triage === undefined ? stalled('CC-1') : { ...stalled('CC-1'), triage }

    expect(ownerDue(claim)).toBe(due)
  })
})
