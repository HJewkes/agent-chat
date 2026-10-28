import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog, INTEGRITY_READMIT_SWEEP } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { IntegrityLedger } from '../broker/integrity-ledger.js'
import { Supervisor, type SupervisorOptions } from '../agents/supervisor.js'

/**
 * TP-4345 S2: once the start's settle window closes, one row says how many of the agents that
 * reattached the ledger re-admitted, and names the rest. Paths, names and ids are synthetic.
 */

const SETTLE_MS = 40
const DESK = 'agdesk01'
const tmpDirs: string[] = []
const closers: (() => void)[] = []
let core: BrokerCore

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-sweep-'))
  tmpDirs.push(dir)
  return dir
}

function supervisor(over: Partial<SupervisorOptions> = {}): Supervisor {
  const built = new Supervisor(core, {
    settleMs: SETTLE_MS,
    nameFreeMs: 50,
    launcherRunning: async () => false,
    surface: {
      platform: 'darwin',
      spawn: (() => ({ pid: 4242, unref: () => undefined, once: () => undefined })) as never,
    },
    ...over,
  })
  closers.push(() => built.close())
  return built
}

beforeEach(() => {
  const home = tmpDir()
  vi.stubEnv('AGENT_CHAT_HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', tmpDir())
  vi.stubEnv('HOME', tmpDir())
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  closers.push(autoAttach(core))
  core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: 'desk',
    msgId: DESK,
    meta: { origin: 'adopted', name: 'desk', cwd: home, depth: '0' },
  })
})

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
  vi.unstubAllEnvs()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A lead a previous broker's ledger admitted, left running when that broker stopped. */
async function survivingLead(): Promise<string> {
  const before = supervisor({ integrity: new IntegrityLedger() })
  const result = await before.spawn({
    name: 'lead',
    profile: 'explorer',
    brief: 'read the log',
    cwd: tmpDir(),
    isolation: 'none',
    surface: 'headless',
    requestedBy: 'human',
  })
  if (!result.ok) throw new Error(`lead not spawned: ${result.reason}`)
  before.close()
  return result.agentId as string
}

const sweeps = () => core.events.since(0, 500).filter(row => row.meta?.event === INTEGRITY_READMIT_SWEEP)
const windowCloses = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS * 3))

describe('TP-4345 S2: the re-admit sweep at broker start', () => {
  it('counts the reattached survivors and names the ones not re-admitted', async () => {
    const lead = await survivingLead()
    const ledger = new IntegrityLedger()
    supervisor({ integrity: ledger })

    core.append({ kind: 'agent_attached', actor: 'lead', ref: lead })
    core.append({ kind: 'agent_attached', actor: 'desk', ref: DESK })
    await windowCloses()

    expect(ledger.knows(lead)).toBe(true)
    expect(sweeps().map(row => row.meta)).toEqual([
      expect.objectContaining({ live: '2', admitted: '1', skipped: '1', skipped_ids: DESK }),
    ])
  })

  it('writes nothing while the ledger is off', async () => {
    const lead = await survivingLead()
    supervisor()

    core.append({ kind: 'agent_attached', actor: 'lead', ref: lead })
    await windowCloses()

    expect(sweeps()).toEqual([])
  })
})
