import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addClaim, EMPTY_LEDGER, readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { linkSlicePr, releaseTask } from '../cli/verbs/burndown-release.js'
import { burndownLedgerPath } from '../paths.js'

/**
 * CC-1181: release, link and a dry run wait (bounded) for the ledger lock a tick holds, instead of
 * refusing at once. The lock is held by `process.ppid`, a live process that is not this one.
 */

let world: string
const saved = { ...process.env }

const held: Claim = {
  taskId: 'DM-9',
  initiative: 'demo',
  agentId: 'a1',
  spawnedAt: '2026-09-26T08:00:00.000Z',
  phase: 'implementing',
  phaseAt: '2026-09-26T08:00:00.000Z',
}

const holdLock = (): void => fs.writeFileSync(`${burndownLedgerPath()}.lock`, `${process.ppid}\n`)

/** A wait whose first sleep is the running tick letting go of the lock. */
const freedOnFirstPoll = () => {
  const polls: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    polls.push(ms)
    fs.rmSync(`${burndownLedgerPath()}.lock`, { force: true })
  }
  return { polls, wait: { waitMs: 60_000, sleep } }
}

const noBroker: TickBroker = {
  roster: async () => ({ agents: [], slots: { held: 0, cap: 36 } }),
  inboxSince: async () => [],
  spawn: async () => ({ ok: false, reason: 'unused' }),
  retire: async () => ({ ok: true }),
  queue: async () => [],
  resume: async () => ({ ok: false, reason: 'unused' }),
  retireFinished: async () => ({ ok: true, plan: [], results: [] }),
  collisionView: async () => ({ names: [], claims: [] }),
  seatSender: async () => ({
    send: async () => ({ ok: true }),
    notify: async () => ({ ok: true }),
    close: () => {},
  }),
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-lock-wait-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  fs.mkdirSync(path.join(world, 'home'), { recursive: true })
  fs.mkdirSync(path.join(world, 'aw'), { recursive: true })
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('manual burndown verbs wait for a running tick (CC-1181)', () => {
  it('lands a release once the running tick lets go of the lock', async () => {
    writeLedger(burndownLedgerPath(), addClaim(EMPTY_LEDGER, held))
    holdLock()
    const { polls, wait } = freedOnFirstPoll()

    const report = await releaseTask(
      'DM-9',
      async () => ({ ok: true }),
      new Date(),
      undefined,
      undefined,
      wait,
    )

    expect(report.ok).toBe(true)
    expect(polls).toHaveLength(1)
    expect(readLedger(burndownLedgerPath()).claims).toEqual([])
  })

  it('refuses a release naming the holder and the wait when the tick never lets go', async () => {
    writeLedger(burndownLedgerPath(), addClaim(EMPTY_LEDGER, held))
    holdLock()
    let clock = 0
    const wait = { waitMs: 2000, now: () => clock, sleep: async (ms: number) => void (clock += ms) }

    const report = await releaseTask(
      'DM-9',
      async () => ({ ok: true }),
      new Date(),
      undefined,
      undefined,
      wait,
    )

    expect(report.errors).toEqual([
      `a tick held the ledger lock (pid ${process.ppid}) for the whole 2s wait; try again`,
    ])
    expect(readLedger(burndownLedgerPath()).claims).toEqual([held])
  })

  it('links a PR to a queued slice once the running tick lets go of the lock', async () => {
    const queued: Claim = { ...held, slice: 'a', phase: 'queued' }
    writeLedger(burndownLedgerPath(), addClaim(EMPTY_LEDGER, queued))
    holdLock()
    const { polls, wait } = freedOnFirstPoll()

    const report = await linkSlicePr('DM-9', 'a', 'acme/widgets#5', wait)

    expect(report.ok).toBe(true)
    expect(polls).toHaveLength(1)
    expect(readLedger(burndownLedgerPath()).claims).toEqual([{ ...queued, pr: 'acme/widgets#5' }])
  })

  it('prints a dry run plan once the running tick lets go of the lock', async () => {
    holdLock()
    const { polls, wait } = freedOnFirstPoll()

    const lines = await tickFromDisk({ dryRun: true, broker: noBroker, log: () => {}, lockWait: wait })

    expect(polls).toHaveLength(1)
    expect(lines.join('\n')).toContain('(dry run)')
    expect(lines.join('\n')).not.toContain('ledger lock')
  })
})
