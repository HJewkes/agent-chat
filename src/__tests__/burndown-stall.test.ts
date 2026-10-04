import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyActions, claimKey, type Observation } from '../agents/burndown/advance.js'
import { findingActions } from '../agents/burndown/finding.js'
import { EMPTY_LEDGER, readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { classify, type ActivityRead } from '../agents/burndown/stall.js'

const MIN = 60_000
const START = Date.parse('2026-10-03T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const claim = { phaseAt: iso(START) }
const row = { spawnedAt: START }
const LAST = START + MIN
const at = (offset: number): Date => new Date(LAST + offset)

describe('classifying a claimed agent', () => {
  it('reads idle only once the last progress is more than 5 min old', () => {
    const activity = { lastAt: iso(LAST) }

    expect(classify(activity, claim, row, at(5 * MIN))).toEqual({ state: 'working' })
    expect(classify(activity, claim, row, at(5 * MIN + 1))).toEqual({ state: 'stalled', reason: 'idle' })
  })

  it('gives a Bash call 15 min and any other tool 5 min', () => {
    const pending = (tool: string) => ({ lastAt: iso(LAST), pending: { tool, at: iso(LAST) } })

    expect(classify(pending('Bash'), claim, row, at(12 * MIN))).toEqual({ state: 'working' })
    expect(classify(pending('Bash'), claim, row, at(16 * MIN))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
    expect(classify(pending('Write'), claim, row, at(6 * MIN))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
  })

  it('reads an unreadable transcript as unknown and a long-missing one as silent', () => {
    const late = new Date(START + 60 * MIN)

    expect(classify('unreadable', claim, row, late)).toEqual({ state: 'unknown' })
    expect(classify('unknown', claim, row, late)).toEqual({ state: 'unknown' })
    expect(classify('missing', claim, row, new Date(START + 5 * MIN))).toEqual({ state: 'working' })
    expect(classify('missing', claim, row, new Date(START + 5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
  })

  it('measures silence from the later of the phase start and the spawn', () => {
    const respawned = { spawnedAt: START + 10 * MIN }
    const beforeRespawn = { lastAt: iso(LAST) }

    expect(classify(beforeRespawn, claim, respawned, new Date(START + 14 * MIN))).toEqual({
      state: 'working',
    })
    expect(classify(beforeRespawn, claim, respawned, new Date(START + 16 * MIN))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
  })

  it('reads work at exactly the claim start as silent only past 5 min, with an empty activity', () => {
    expect(classify({ lastAt: iso(START) }, claim, row, new Date(START + 5 * MIN))).toEqual({
      state: 'working',
    })
    expect(classify({ lastAt: iso(START) }, claim, row, new Date(START + 5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
    expect(classify({}, claim, row, new Date(START + 5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
  })

  it('treats the exact slow-tool boundaries as still working', () => {
    const pending = (tool: string) => ({ lastAt: iso(LAST), pending: { tool, at: iso(LAST) } })

    expect(classify(pending('Bash'), claim, row, at(15 * MIN))).toEqual({ state: 'working' })
    expect(classify(pending('Monitor'), claim, row, at(15 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
    expect(classify(pending('Write'), claim, row, at(5 * MIN))).toEqual({ state: 'working' })
    expect(classify(pending('Write'), claim, row, at(5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
  })

  it('reads an open tool call with an unparseable start as unknown', () => {
    const activity = { lastAt: iso(LAST), pending: { tool: 'Bash', at: 'not a date' } }

    expect(classify(activity, claim, row, at(60 * MIN))).toEqual({ state: 'unknown' })
  })

  it('falls back to the spawn time when phaseAt is invalid and reads unknown when both are', () => {
    const late = new Date(START + 5 * MIN + 1)

    expect(classify({}, { phaseAt: 'not a date' }, row, late)).toEqual({ state: 'stalled', reason: 'silent' })
    expect(classify({}, { phaseAt: 'not a date' }, { spawnedAt: Number.NaN }, late)).toEqual({
      state: 'unknown',
    })
  })
})

describe('the finding on a claim', () => {
  const NOW0 = new Date(START + 10 * MIN)
  const held = (patch: Partial<Claim> = {}): Claim => ({
    taskId: 'CC-1',
    initiative: 'demo',
    agentId: 'a1',
    agentName: 'bd-cc-1',
    spawnedAt: iso(START),
    phase: 'implementing',
    phaseAt: iso(START),
    ...patch,
  })
  const observed = (c: Claim, read: ActivityRead): Map<string, Observation> =>
    new Map([
      [claimKey(c), { agent: { id: 'a1', state: 'live' as const }, activity: { read, spawnedAt: START } }],
    ])
  const tickAt = (c: Claim, read: ActivityRead, now: Date, moved = new Set<string>()): Claim =>
    applyActions({ ...EMPTY_LEDGER, claims: [c] }, findingActions([c], observed(c, read), moved, now), now)
      .claims[0] as Claim
  const idleSince = { lastAt: iso(LAST) }

  it('keeps openedAt and a single finding across a repeat tick with the same evidence', () => {
    const opened = tickAt(held(), idleSince, NOW0)

    const refreshed = tickAt(opened, idleSince, new Date(NOW0.getTime() + 10 * MIN))

    expect(opened.finding).toMatchObject({ reason: 'idle', since: iso(LAST), openedAt: NOW0.toISOString() })
    expect(refreshed.finding).toMatchObject({
      openedAt: NOW0.toISOString(),
      checkedAt: new Date(NOW0.getTime() + 10 * MIN).toISOString(),
    })
  })

  it('opens an idle finding with the no-progress code at the head of its detail', () => {
    const opened = tickAt(held(), idleSince, NOW0)

    expect(opened.finding).toMatchObject({ code: 'no-progress', reason: 'idle' })
    expect(opened.finding?.detail).toMatch(/^no-progress: idle: /)
  })

  it('closes the finding once the agent shows a newer progress row', () => {
    const opened = tickAt(held(), idleSince, NOW0)

    const closed = tickAt(opened, { lastAt: iso(NOW0.getTime() - MIN) }, NOW0)

    expect(closed.finding).toBeUndefined()
  })

  it('leaves the finding open when notified, inboxCursor and lastTickAt are fresh', () => {
    const fresh = held({ notified: ['leak'], inboxCursor: '9', phaseAt: iso(START) })

    const opened = tickAt(fresh, idleSince, NOW0)

    expect(opened.finding?.reason).toBe('idle')
    expect(opened.notified).toEqual(['leak'])
  })

  it('keeps an open finding untouched when the transcript cannot be read', () => {
    const opened = tickAt(held(), idleSince, NOW0)

    const later = tickAt(opened, 'unreadable', new Date(NOW0.getTime() + 10 * MIN))

    expect(later.finding).toEqual(opened.finding)
  })

  it('closes the finding of a claim advance moved', () => {
    const opened = tickAt(held(), idleSince, NOW0)

    const closed = tickAt(opened, idleSince, NOW0, new Set([claimKey(opened)]))

    expect(closed.finding).toBeUndefined()
  })

  it('closes the finding of a claim stalled for the owner', () => {
    const opened = tickAt(held(), idleSince, NOW0)

    const closed = tickAt({ ...opened, stalledReason: 'timed out' }, idleSince, NOW0)

    expect(closed.finding).toBeUndefined()
  })

  it('parses a ledger with and without a finding', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-ledger-'))
    const file = path.join(dir, 'ledger.json')
    const opened = tickAt(held(), idleSince, NOW0)

    writeLedger(file, { ...EMPTY_LEDGER, claims: [held()] })
    const without = readLedger(file).claims[0]
    writeLedger(file, { ...EMPTY_LEDGER, claims: [opened] })
    const withFinding = readLedger(file).claims[0]
    const { code: _code, ...uncoded } = opened.finding!
    writeLedger(file, { ...EMPTY_LEDGER, claims: [{ ...opened, finding: uncoded }] })
    const preCode = readLedger(file).claims[0]
    fs.rmSync(dir, { recursive: true, force: true })

    expect(without?.finding).toBeUndefined()
    expect(withFinding?.finding).toEqual(opened.finding)
    expect(preCode?.finding).toEqual(uncoded)
  })
})
