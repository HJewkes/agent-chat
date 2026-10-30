import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import type { StatusDeps } from '../agents/seats/status.js'
import { seatStatus } from '../agents/seats/status.js'
import type { BootDeps } from '../agents/seats/boot.js'
import { bootReport, statusReport } from '../cli/verbs/seats.js'

/** CC-486 b: a timed-out agents read is unknown, never a seat with zero agents. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const SEAT = 'sample-seat'
const TIMEOUT = 'broker did not answer agents_result within 5s'

let tmp: string
let autonomy: string

function deps(agents: StatusDeps['agents']): StatusDeps {
  return {
    now: () => new Date(2026, 8, 29, 10, 0),
    autonomyRoot: autonomy,
    homeDir: tmp,
    agents,
    waitingOwner: async () => [],
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    loadDoc: () => ({ seats: {}, pools: {}, stopped: {} }),
    inbox: () => ({ unread: 0, sinceLastSend: null }),
    poolPicks: () => [],
    scored: () => {
      throw new Error('no scorer in this test')
    },
    machine: roster => ({
      headlessAgents: { live: roster.length, limit: 10 },
      memoryFree: { percent: 50, limit: 15 },
      cpuPressure: { someAvg60: null, limit: 40, skipped: true },
      swap: { usedPercent: 10 },
      fullSuiteSlots: { inUse: 0, total: 4 },
      headroom: {
        tmp_inodes: { usedPercent: 13, limit: 70 },
        tmp_bytes: { usedPercent: 20, limit: 85 },
        disk_bytes: { usedPercent: 40, limit: 90 },
      },
      holding: null,
    }),
    machineStop: () => null,
  }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-roster-unknown-')))
  autonomy = path.join(tmp, 'autonomy')
  const extra = 'prefix: ss\nconcurrency: {implementers: 2, reviewers: 1, planners: 3}'
  fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
  fs.copyFileSync(path.join(FIXTURE, 'charter.md'), path.join(autonomy, 'charter.md'))
  fs.writeFileSync(
    path.join(autonomy, 'seats', `${SEAT}.md`),
    fs
      .readFileSync(path.join(FIXTURE, 'seats/sample-seat.md'), 'utf8')
      .replace(/\n---\n$/, `\n${extra}\n---\n`),
  )
})

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const timesOut = async (): Promise<never> => {
  throw new Error(TIMEOUT)
}

describe('seats status when the agents read times out', () => {
  it('prints unknown in text and brief, with no zero counts', async () => {
    for (const brief of [false, true]) {
      const report = await statusReport(deps(timesOut), SEAT, false, brief)
      const text = report.lines.join('\n')
      expect(report.ok).toBe(true)
      expect(text).toContain(`agents        unknown (${TIMEOUT})`)
      expect(text).not.toMatch(/implementers|parked|0\/2/)
      if (!brief) expect(text).toContain('headless unknown/10')
    }
  })

  it('reports null agent fields and the reason in --json', async () => {
    const report = await statusReport(deps(timesOut), SEAT, true)
    const doc = JSON.parse(report.lines.join('\n'))
    expect(doc.rosterUnknown).toBe(TIMEOUT)
    expect(doc.machine.headlessAgents).toEqual({ live: null, limit: 10 })
    expect(doc.machine.memoryFree.percent).toBe(50)
    for (const key of [
      'implementers',
      'reviewers',
      'planners',
      'other',
      'parked',
      'waitingPermission',
      'agents',
    ])
      expect(doc[key]).toBeNull()
  })

  it('still fails the run on a broker error that is not a missed reply', async () => {
    const report = await statusReport(
      deps(async () => {
        throw new Error('socket closed')
      }),
      SEAT,
      false,
    )
    expect(report.ok).toBe(false)
  })

  it('keeps an answered empty roster as zero agents, not unknown', async () => {
    const report = await statusReport(
      deps(async () => []),
      SEAT,
      true,
    )
    const doc = JSON.parse(report.lines.join('\n'))
    expect(doc.rosterUnknown).toBeUndefined()
    expect(doc.implementers.active).toBe(0)
  })

  describe('seats boot', () => {
    const unreadable = async (): Promise<never> => {
      throw new Error('not read in this test')
    }
    const bootDeps = (agents: StatusDeps['agents']): BootDeps => ({
      now: () => new Date(2026, 8, 29, 10, 0),
      autonomyRoot: autonomy,
      homeDir: tmp,
      eventsDb: path.join(tmp, 'events.db'),
      status: seat => seatStatus(deps(agents), seat),
      inFlight: {} as BootDeps['inFlight'],
      ready: unreadable,
    })

    it('prints agents unknown in text, with no caps', async () => {
      const report = await bootReport(bootDeps(timesOut), SEAT, undefined, false)
      const text = report.lines.join('\n')
      expect(text).toContain(`agents unknown (${TIMEOUT})`)
      expect(text).not.toMatch(/caps |parked /)
    })

    it('nulls every roster-derived field in --json', async () => {
      const report = await bootReport(bootDeps(timesOut), SEAT, undefined, true)
      const { status } = JSON.parse(report.lines.join('\n'))
      expect(status.rosterUnknown).toBe(TIMEOUT)
      for (const key of [
        'implementers',
        'reviewers',
        'planners',
        'other',
        'parked',
        'waitingPermission',
        'agents',
      ])
        expect(status[key]).toBeNull()
      expect(status.machine.headlessAgents.live).toBeNull()
    })
  })
})
