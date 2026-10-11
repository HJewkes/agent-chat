import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBackfill } from '../agents/ledger/backfill-run.js'
import { EventLog } from '../broker/event-log.js'
import { reapBroker } from './broker-harness.js'

/**
 * CC-153, against built brokers on one temp home: after a stop, every attached
 * client auto-starts a broker at once. Only the one that wins the listen may open
 * `events.db`, and the boot backfill must run once with no `ledger_shadow_error`.
 *
 * The test holds its own write lock on `events.db` while the brokers race. A
 * broker that touches the ledger before listening blocks on that lock, so losers
 * that exit while it is still held have provably touched nothing.
 */

const AGENTS = 40
const BROKERS = 4
/** Under the event log's 5s busy timeout, so the winner waits the lock out rather than failing. */
const LOCK_HOLD_MS = 3_000

const shortTmp = (): string => os.tmpdir()
const entry = (): string => path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

let dir: string
let children: ChildProcess[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac-cc153-'))
})

afterEach(async () => {
  await reapBroker(dir)
  for (const child of children) child.kill('SIGKILL')
  children = []
  fs.rmSync(dir, { recursive: true, force: true })
})

const eventsFile = (): string => path.join(dir, 'events.db')

function seedAgents(): void {
  const events = new EventLog(eventsFile())
  for (let i = 0; i < AGENTS; i += 1)
    events.append({ kind: 'agent_spawned', actor: 'human', target: `a${i}`, meta: { session_id: `s${i}` } })
  events.close()
}

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

async function launchBrokers(count: number): Promise<void> {
  const env = {
    ...process.env,
    AGENT_CHAT_HOME: dir,
    AGENT_CHAT_LEDGER_SHADOW: '1',
    AGENT_CHAT_PORT: String(await freePort()),
  }
  for (let i = 0; i < count; i += 1)
    children.push(spawn(process.execPath, [entry(), 'broker'], { env, stdio: 'ignore' }))
}

const logLines = (): Record<string, unknown>[] => {
  const file = path.join(dir, 'broker.log')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

const logged = (event: string): Record<string, unknown>[] => logLines().filter(line => line.event === event)

/** A loser exits through `service start`'s probe or `startBroker`'s bind, and either way exits 0. */
const exitedCleanly = (): number => children.filter(child => child.exitCode === 0).length

async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return check()
}

function ledgerRows(): number {
  const db = new DatabaseSync(eventsFile())
  try {
    return (db.prepare('SELECT count(*) AS n FROM agent_execution').get() as { n: number }).n
  } finally {
    db.close()
  }
}

describe('brokers auto-started together after a stop', () => {
  it('let only the listen winner touch events.db, and backfill once with no shadow error', async () => {
    seedAgents()
    const lock = new DatabaseSync(eventsFile(), { timeout: 5_000 })
    lock.exec('BEGIN IMMEDIATE')

    await launchBrokers(BROKERS)
    const losersExitedUnderLock = await until(() => exitedCleanly() === BROKERS - 1, LOCK_HOLD_MS)
    lock.exec('COMMIT')
    lock.close()
    const sockUp = await until(() => fs.existsSync(path.join(dir, 'chat.sock')), 5_000)
    const backfilled = await until(() => logged('ledger_backfill').length > 0, 10_000)

    expect(losersExitedUnderLock).toBe(true)
    expect(sockUp && backfilled).toBe(true)
    expect(logged('ledger_backfill')).toEqual([expect.objectContaining({ planned: AGENTS, applied: AGENTS })])
    expect(logged('ledger_shadow_error')).toEqual([])
    expect(ledgerRows()).toBe(AGENTS)
    expect(children.filter(child => child.exitCode === null)).toHaveLength(1)
  })

  it('skip the backfill when another writer completes it while this broker waits for the lock', async () => {
    const previous = process.env.AGENT_CHAT_HOME
    process.env.AGENT_CHAT_HOME = dir
    const events = new EventLog(eventsFile())
    const fence = { supervisorId: `agent-chat@${dir}`, generation: 1 }
    // A bounded run over no agents commits the ledger tables, so the broker's DDL never waits on our lock.
    runBackfill(events, { fence, sinceDays: 1 })
    seedAgents()
    const db = events.ledgerHandle()
    db.exec('BEGIN IMMEDIATE')
    runBackfill(events, { fence })

    await launchBrokers(1)
    const sockUp = await until(() => fs.existsSync(path.join(dir, 'chat.sock')), 5_000)
    await new Promise(resolve => setTimeout(resolve, 500))
    db.exec('COMMIT')
    events.close()
    if (previous === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = previous
    await until(() => logged('http_started').length > 0 || logged('http_unavailable').length > 0, 10_000)

    expect(sockUp).toBe(true)
    expect(logged('ledger_backfill')).toEqual([])
    expect(logged('ledger_backfill_duplicate')).toEqual([])
    expect(logged('ledger_shadow_error')).toEqual([])
    expect(ledgerRows()).toBe(AGENTS)
  })
})
