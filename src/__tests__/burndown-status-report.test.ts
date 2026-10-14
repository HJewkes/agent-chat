import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advance, applyActions, type Action } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { observe, type ObserveDeps } from '../agents/burndown/observe.js'
import { pickReport, readStatusReport } from '../agents/burndown/status-report.js'
import { EventLog } from '../broker/event-log.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-980: a finished worker is judged by its last Status message to reportTo, not by the transcript's last text. */

const PR = 'https://github.com/o/r/pull/9'
const DONE = `Status: DONE\nPR: ${PR}`
const NOW = new Date('2026-10-14T12:00:00.000Z')
const EARLIER = '2026-10-14T09:00:00.000Z'

describe('readStatusReport', () => {
  let dir: string
  let dbPath: string
  let log: EventLog

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-report-'))
    dbPath = path.join(dir, 'events.db')
    log = new EventLog(dbPath)
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    log.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const send = (actor: string, target: string, body: string, ts: number): void => {
    vi.setSystemTime(ts)
    log.append({ kind: 'message', actor, target, body })
  }

  it('returns the newest terminal report the worker sent reportTo since its spawn', () => {
    send('tc-1', 'coord', 'Status: BLOCKED', 100)
    send('tc-1', 'coord', DONE, 200)

    expect(readStatusReport(dbPath, 'tc-1', 'coord', 50)).toBe(DONE)
  })

  it('ignores a report to another recipient', () => {
    send('tc-1', 'someone-else', DONE, 200)

    expect(readStatusReport(dbPath, 'tc-1', 'coord', 50)).toBeUndefined()
  })

  it("ignores an earlier same-name dispatch's report sent before this row's spawn", () => {
    send('tc-1', 'coord', DONE, 100)

    expect(readStatusReport(dbPath, 'tc-1', 'coord', 150)).toBeUndefined()
  })

  it('skips later prose and a later IN PROGRESS status', () => {
    send('tc-1', 'coord', DONE, 200)
    send('tc-1', 'coord', 'I fixed the blocking finding and pushed.', 300)
    send('tc-1', 'coord', 'Status: IN PROGRESS', 400)

    expect(readStatusReport(dbPath, 'tc-1', 'coord', 50)).toBe(DONE)
  })

  it('gives undefined for a missing db rather than throwing', () => {
    expect(readStatusReport(path.join(dir, 'absent.db'), 'tc-1', 'coord', 0)).toBeUndefined()
  })
})

describe('pickReport', () => {
  it('prefers the broker report over prose in the transcript', () => {
    const report = pickReport(DONE, 'I fixed the blocking finding.')

    expect(report).toEqual(expect.objectContaining({ status: 'DONE', pr: PR }))
  })

  it('keeps a parked final text over a broker report', () => {
    const report = pickReport(DONE, 'Status: NEEDS_CONTEXT\nPARKED q1')

    expect(report?.parked).toBe('q1')
  })

  it('falls back to the final text when the broker has no report', () => {
    expect(pickReport(undefined, DONE)).toEqual(expect.objectContaining({ status: 'DONE', pr: PR }))
    expect(pickReport(undefined, undefined)).toBeUndefined()
  })
})

describe('an exited implementer that ended on prose after a Shepherd resume (CC-980)', () => {
  const claim: Claim = {
    taskId: 'CC-1',
    initiative: 'demo',
    agentId: 'a1',
    agentName: 'tc-cc-1',
    spawned: ['tc-cc-1'],
    spawnedAt: EARLIER,
    phase: 'implementing',
    phaseAt: EARLIER,
    worktree: '/parked/tree',
  }
  const row = { agentId: 'a1', name: 'tc-cc-1', state: 'exited', spawnedAt: 1 } as AgentIdentity

  async function tickActions(deps: Partial<ObserveDeps>): Promise<Action[]> {
    const { observations } = await observe(
      [claim],
      { agents: [row] },
      {
        root: '/nowhere',
        inboxSince: async () => [],
        finalText: () => 'I fixed the blocking finding and pushed.',
        diff: () => ({ reviewable: true, reason: '1 commit ahead' }),
        exitedWork: () => undefined,
        shepherdRows: () => [],
        openPrs: () => [],
        spendCap: () => undefined,
        spend: async () => ({ ok: false, reason: 'stub' }) as never,
        ...deps,
      },
    )
    return advance([claim], observations, NOW)
  }

  it('hands its broker-reported PR to Shepherd', async () => {
    const actions = await tickActions({ statusReport: () => DONE })

    const after = applyActions({ ...EMPTY_LEDGER, claims: [claim] }, actions, NOW).claims
    expect(actions.filter(a => a.kind === 'register')).toEqual([
      expect.objectContaining({ registration: expect.objectContaining({ target: { repo: 'o/r', pr: 9 } }) }),
    ])
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding' })])
  })

  it('reads only the transcript when the broker has no report', async () => {
    const actions = await tickActions({ statusReport: () => undefined })

    expect(actions.filter(a => a.kind === 'register')).toEqual([])
  })

  it('still parks on a PARKED final text', async () => {
    const actions = await tickActions({
      statusReport: () => DONE,
      finalText: () => 'Status: NEEDS_CONTEXT\nPARKED q1',
    })

    const after = applyActions({ ...EMPTY_LEDGER, claims: [claim] }, actions, NOW).claims
    expect(actions.filter(a => a.kind === 'register')).toEqual([])
    expect(after).toEqual([expect.objectContaining({ phase: 'parked' })])
  })
})
