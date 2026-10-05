import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { errorClass, readTickStatus } from '../agents/burndown/tick-status.js'
import { burndownLedgerPath, burndownTickStatusPath } from '../paths.js'

/** The tick over an empty world: a temp AGENT_CHAT_HOME and active-work root, and a broker that has nothing. */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)

const broker: TickBroker = {
  roster: async () => ({ agents: [], slots: { held: 0, cap: 36 } }),
  inboxSince: async () => [],
  spawn: async () => ({ ok: true }),
  retire: async () => ({ ok: true }),
  queue: async () => [],
  resume: async () => ({ ok: true }),
  collisionView: async () => ({ names: [], claims: [] }),
  seatSender: async () => ({
    send: async () => ({ ok: true }),
    notify: async () => ({ ok: true }),
    close: () => undefined,
  }),
}

const options = (dryRun = false) => ({ dryRun, broker, now: NOON, log: () => undefined })
const status = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(burndownTickStatusPath(), 'utf8')) as Record<string, unknown>
const breakLedger = (): void => fs.writeFileSync(burndownLedgerPath(), '{ not json, invented-ledger-text')
const fixLedger = (): void => fs.rmSync(burndownLedgerPath(), { force: true })

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tick-status-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  fs.mkdirSync(path.join(world, 'home'), { recursive: true })
  fs.mkdirSync(path.join(world, 'aw'), { recursive: true })
  fs.writeFileSync(
    path.join(world, 'home', 'burndown.config.json'),
    JSON.stringify({ enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2 }),
  )
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('burndown tick status', () => {
  // Mutation caught: rethrowing after the record, or writing err.message.
  it('records a malformed ledger as a failure by class in the file, without rejecting, and prints the error for the local log', async () => {
    breakLedger()

    const lines = await tickFromDisk(options())

    expect(status()).toMatchObject({
      version: 1,
      loop: 'burndown-tick',
      outcome: 'failed',
      consecutiveFailures: 1,
      lastErrorClass: 'LedgerMalformedError',
      intervalSeconds: 600,
    })
    expect(fs.readFileSync(burndownTickStatusPath(), 'utf8')).not.toContain('malformed')
    expect(lines.join('\n')).toContain('burndown ledger')
    expect(lines.join('\n')).toContain('malformed')
    expect(fs.statSync(burndownTickStatusPath()).mode & 0o777).toBe(0o600)
  })

  // Mutation caught: a count that never resets, or a reset on skipped.
  it('counts 1, 2 across bad ticks and resets to 0 with lastOkAt on a good one', async () => {
    breakLedger()
    await tickFromDisk(options())
    expect(status()['consecutiveFailures']).toBe(1)
    await tickFromDisk(options())
    expect(status()['consecutiveFailures']).toBe(2)

    fixLedger()
    await tickFromDisk(options())

    expect(status()).toMatchObject({
      outcome: 'ok',
      consecutiveFailures: 0,
      lastOkAt: NOON.toISOString(),
    })
    expect(status()['lastErrorClass']).toBeUndefined()
  })

  // Mutation caught: a lock-held tick counted as a failure, or as a success.
  it('records a held lock as skipped and keeps the count', async () => {
    breakLedger()
    await tickFromDisk(options())
    fs.writeFileSync(`${burndownLedgerPath()}.lock`, `${process.ppid}\n`)

    await tickFromDisk(options())

    expect(status()).toMatchObject({ outcome: 'skipped', consecutiveFailures: 1 })
  })

  // Mutation caught: a stopped tick counted as a failure or a reset.
  it('records a paused tick as stopped with its reason and keeps the count', async () => {
    breakLedger()
    await tickFromDisk(options())
    fs.writeFileSync(path.join(world, 'home', 'burndown.paused'), '')

    await tickFromDisk(options())

    expect(status()).toMatchObject({ outcome: 'stopped', reason: 'paused', consecutiveFailures: 1 })
  })

  // Mutation caught: a dry run that writes.
  it('writes no status file on a dry run, and the dry run still throws', async () => {
    breakLedger()

    await expect(tickFromDisk(options(true))).rejects.toThrow()

    expect(fs.existsSync(burndownTickStatusPath())).toBe(false)
  })

  it('treats a corrupt status file as zero failures', async () => {
    fs.writeFileSync(burndownTickStatusPath(), 'not json')
    expect(readTickStatus(burndownTickStatusPath())).toEqual({})

    breakLedger()
    await tickFromDisk(options())

    expect(status()['consecutiveFailures']).toBe(1)
  })
})

describe('errorClass', () => {
  const named = (name: string): Error => Object.assign(new Error('invented message text'), { name })

  it.each([
    ['a plain name', 'LedgerMalformedError', 'LedgerMalformedError'],
    ['a name with a space', 'bad name', 'Error'],
    ['a path-shaped name', '/tmp/invented/path', 'Error'],
    ['an over-long name', 'A'.repeat(65), 'Error'],
    ['a github token prefix', 'ghp_inventedvalue', 'Error'],
    ['a fine-grained token prefix', 'github_pat_invented', 'Error'],
    ['a jwt prefix', 'eyJinvented', 'Error'],
    ['a hex run', `X${'ab12'.repeat(8)}`, 'Error'],
  ])('maps %s', (_label, name, expected) => {
    expect(errorClass(named(name))).toBe(expected)
  })

  it('maps a thrown non-error to Error', () => {
    expect(errorClass('invented string')).toBe('Error')
  })
})
