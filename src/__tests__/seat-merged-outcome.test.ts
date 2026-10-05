import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { deliverSeatEvents, type SeatSender } from '../agents/burndown/seat-deliver.js'
import { seatMergedLog } from '../agents/seats/dispatch-log.js'
import { foldDispatch } from '../agents/seats/dispatch-record.js'

/** CC-469: the tick appends a merged row to the seat's dispatch log. Every seat, repo and task here is synthetic. */

const NOW = new Date('2026-02-03T04:05:06.000Z')
const AGENT = 'sx-ab-12'
const PR = 'acme/widgets#7'

let root: string

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'AB-12',
  initiative: 'demo',
  spawnedAt: NOW.toISOString(),
  phase: 'done',
  phaseAt: NOW.toISOString(),
  seat: 'seat-x',
  namePrefix: 'sx',
  agentId: 'id-1',
  pr: 'https://github.com/acme/widgets/pull/7',
  notified: ['dispatched', 'ready-to-merge'],
  ...over,
})
const ledger = (...claims: Claim[]): Ledger => ({ ...EMPTY_LEDGER, claims })

const sender = (ok: boolean) => async (): Promise<SeatSender> => ({
  send: async () => (ok ? { ok: true } : { ok: false, reason: 'offline' }),
  notify: async () => ({ ok: true }),
  close: () => undefined,
})

const tick = (after: Ledger, ok = true) =>
  deliverSeatEvents(
    { seats: ['seat-x'], before: ledger(claim({ phase: 'awaiting-merge' })), after, spawns: [] },
    {
      open: sender(ok),
      log: () => undefined,
      now: NOW,
      dispatch: seatMergedLog(root, { now: () => NOW, activeWork: root, log: () => undefined }),
    },
  )

const logFile = (): string => path.join(root, 'logs', 'seat-x', 'dispatch.jsonl')

const rows = (): Record<string, unknown>[] =>
  fs.existsSync(logFile())
    ? fs
        .readFileSync(logFile(), 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : []

const handWrite = (row: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(logFile()), { recursive: true })
  fs.appendFileSync(logFile(), `${JSON.stringify(row)}\n`)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'merged-outcome-')))
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(path.join(root, 'seats', 'seat-x.md'), '---\nprefix: sx\npool: pool-a\n---\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a merged row from the burndown tick', () => {
  it('writes one row for a merge with no row yet', async () => {
    await tick(ledger(claim()))

    expect(rows()).toEqual([
      { ts: NOW.toISOString(), task: 'AB-12', agent: AGENT, pr: PR, outcome: 'merged', by: 'burndown' },
    ])
  })

  it('adds nothing when a hand-written merged row for that agent and PR exists', async () => {
    handWrite({ ts: '2026-02-03T04:00:00Z', task: 'AB-12', agent: AGENT, pr: PR, outcome: 'merged' })

    await tick(ledger(claim()))

    expect(rows()).toHaveLength(1)
    expect(rows()[0]).not.toHaveProperty('by')
  })

  it('adds nothing on a second tick over the same merge', async () => {
    await tick(ledger(claim()), false)
    await tick(ledger(claim()), false)

    expect(rows()).toHaveLength(1)
  })

  it('still writes when the only merged row names another PR', async () => {
    handWrite({ agent: AGENT, pr: 'acme/widgets#6', outcome: 'merged' })

    await tick(ledger(claim()))

    expect(rows().map(r => r.pr)).toEqual(['acme/widgets#6', PR])
  })

  it('writes nothing for a merge whose agent no seat owns', async () => {
    await tick(ledger(claim({ namePrefix: 'zz' })))

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
  })

  it('folds the run it closes as merged', async () => {
    handWrite({
      ts: '2026-02-03T03:00:00Z',
      agent: AGENT,
      outcome: 'dispatched',
      by: 'broker',
      agent_id: 'id-1',
    })

    await tick(ledger(claim()))

    const [record] = foldDispatch(fs.readFileSync(logFile(), 'utf8')).records
    expect(record).toMatchObject({ agent: AGENT, outcome: 'merged', pr: PR })
  })
})
