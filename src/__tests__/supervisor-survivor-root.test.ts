import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import {
  EventLog,
  INTEGRITY_QUARANTINE,
  INTEGRITY_READMIT_SKIPPED,
  INTEGRITY_READMITTED,
  INTEGRITY_WIRED_SINCE,
} from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { HUMAN_ROOT, IntegrityLedger, LINEAGE } from '../broker/integrity-ledger.js'
import { Supervisor } from '../agents/supervisor.js'
import type { ProcessProbe } from '../agents/detached-reap.js'
import type { SessionRecord } from '../agents/claude-sessions.js'

/**
 * TP-4345 S3: a survivor that reattaches after a restart roots past ancestors that are not running.
 * These rows cover what needs the supervisor: D3, "not exited" is not running, and the record a
 * skipped ancestor carries. Paths, names and ids are synthetic.
 */

const STALE = 'agstale01'
const REMOTE = 'agremot01'
const tmpDirs: string[] = []
const closers: (() => void)[] = []
let core: BrokerCore

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-root-'))
  tmpDirs.push(dir)
  return dir
}

/** Every pid is alive with an unreadable argv; only these Claude Code sessions are held. */
const probeHolding = (sessions: readonly SessionRecord[]): ProcessProbe => ({
  isAlive: () => true,
  readArgv: () => undefined,
  sessionRecords: () => [...sessions],
})

const OTHER_SESSION = { pid: 7001, sessionId: 'session-other' }

function supervisor(probe: ProcessProbe, ledger?: IntegrityLedger): Supervisor {
  const built = new Supervisor(core, {
    ...(ledger === undefined ? {} : { integrity: ledger }),
    processProbe: probe,
    nameFreeMs: 50,
    launcherRunning: async () => false,
    surface: {
      platform: 'darwin',
      spawn: (() => ({ pid: 4242, unref: () => undefined, once: () => undefined })) as never,
    },
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
    target: 'stale',
    msgId: STALE,
    meta: {
      ...{ origin: 'spawned', name: 'stale', cwd: home, parent: '', profile: 'coord' },
      session_id: `session-${STALE}`,
    },
  })
  core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: 'remote',
    msgId: REMOTE,
    meta: {
      ...{ origin: 'spawned', name: 'remote', cwd: home, parent: '', profile: 'coord' },
      ...{ session_id: `session-${REMOTE}`, host: 'synthetic-remote-host' },
    },
  })
  fs.mkdirSync(path.join(home, 'profiles'))
  fs.writeFileSync(
    path.join(home, 'profiles', 'coord.json'),
    JSON.stringify({
      role: 'coordinator',
      model: 'opus',
      allowedTools: ['Read'],
      isolation: 'none',
      surface: 'headless',
    }),
  )
})

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
  vi.unstubAllEnvs()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A lead an unwired broker spawned under `parent` and left running, then the first wired start. */
async function survivorUnderStale(parent = STALE): Promise<string> {
  const before = supervisor(probeHolding([]))
  const result = await before.spawn({
    name: 'lead',
    profile: 'explorer',
    brief: 'read the log',
    cwd: tmpDir(),
    isolation: 'none',
    surface: 'headless',
    requestedBy: parent === REMOTE ? 'remote' : 'stale',
    parentAgentId: parent,
  })
  if (!result.ok) throw new Error(`lead not spawned: ${result.reason}`)
  before.close()
  await new Promise(resolve => setTimeout(resolve, 20))
  core.append({
    kind: 'notice',
    actor: 'agent-chat',
    target: 'agent-chat',
    body: '',
    meta: { event: INTEGRITY_WIRED_SINCE },
  })
  return result.agentId as string
}

const rows = (event: string) => core.events.since(0, 500).filter(row => row.meta?.event === event)
const attach = (agentId: string) => core.append({ kind: 'agent_attached', actor: 'lead', ref: agentId })

function recordQuarantine(agentId: string, file: string, field: string): void {
  core.append({
    kind: 'notice',
    actor: 'agent-chat',
    target: 'agent-chat',
    body: `integrity: ${agentId} quarantined`,
    meta: { event: INTEGRITY_QUARANTINE, agent_id: agentId, file, field },
  })
}

describe('TP-4345 S3: the survivor root after a restart', () => {
  it('D3: skips an ancestor that is detached but holds no running session, and roots at the human', async () => {
    const lead = await survivorUnderStale()
    core.append({ kind: 'agent_detached', actor: 'stale', ref: STALE })
    const ledger = new IntegrityLedger()
    supervisor(probeHolding([OTHER_SESSION]), ledger)

    attach(lead)

    expect(core.agents.get(STALE)?.state).toBe('detached')
    expect(ledger.parentOf(lead)).toBe(HUMAN_ROOT)
    expect(rows(INTEGRITY_READMITTED).map(row => row.meta?.agent_id)).toEqual([lead])
  })

  it('D3: keeps an ancestor whose session is still held as the root, so the lead waits on it', async () => {
    const lead = await survivorUnderStale()
    core.append({ kind: 'agent_detached', actor: 'stale', ref: STALE })
    const ledger = new IntegrityLedger()
    supervisor(probeHolding([OTHER_SESSION, { pid: 7002, sessionId: `session-${STALE}` }]), ledger)

    attach(lead)

    expect(ledger.knows(lead)).toBe(false)
    expect(rows(INTEGRITY_READMIT_SKIPPED).map(row => row.meta?.reason)).toContain(
      `lineage unresolved via ${STALE} (detached)`,
    )
  })

  it('latches the survivor on a file quarantine recorded for a skipped ancestor', async () => {
    const lead = await survivorUnderStale()
    core.append({ kind: 'agent_exited', actor: 'stale', ref: STALE, body: '', meta: {} })
    recordQuarantine(STALE, '/synthetic/settings.json', 'sha256')
    const ledger = new IntegrityLedger()
    supervisor(probeHolding([OTHER_SESSION]), ledger)

    attach(lead)

    expect(ledger.verdict(lead)).toMatchObject({
      ok: false,
      reason: 'quarantined',
      file: '/synthetic/settings.json',
    })
    expect(rows(INTEGRITY_READMIT_SKIPPED).map(row => row.meta?.reason)).toEqual([
      `files: /synthetic/settings.json/sha256 (on record for ${STALE})`,
    ])
  })

  it('latches on a lineage record of a skipped ancestor too, until TP-4348 weighs those', async () => {
    const lead = await survivorUnderStale()
    core.append({ kind: 'agent_exited', actor: 'stale', ref: STALE, body: '', meta: {} })
    recordQuarantine(STALE, LINEAGE, 'quarantined parent')
    const ledger = new IntegrityLedger()
    supervisor(probeHolding([OTHER_SESSION]), ledger)

    attach(lead)

    expect(ledger.verdict(lead)).toMatchObject({
      ok: false,
      reason: 'quarantined',
      field: 'quarantined parent',
    })
  })

  it('keeps a not-ended ancestor on another host as the root, since no probe here can prove it gone', async () => {
    const lead = await survivorUnderStale(REMOTE)
    core.append({ kind: 'agent_detached', actor: 'remote', ref: REMOTE })
    const ledger = new IntegrityLedger()
    supervisor(probeHolding([OTHER_SESSION]), ledger)

    attach(lead)

    expect(ledger.knows(lead)).toBe(false)
    expect(rows(INTEGRITY_READMIT_SKIPPED).map(row => row.meta?.reason)).toContain(
      `lineage unresolved via ${REMOTE} (detached)`,
    )
  })

  it('writes one skip row for a survivor whose lineage loops', async () => {
    for (const [id, parent] of [
      ['agloop001', 'agloop002'],
      ['agloop002', 'agloop001'],
    ] as const)
      core.append({
        kind: 'agent_spawned',
        actor: 'human',
        target: 'stale',
        msgId: id,
        meta: { origin: 'spawned', name: 'stale', parent, profile: 'coord', session_id: `session-${id}` },
      })
    const lead = await survivorUnderStale('agloop001')
    for (const id of ['agloop001', 'agloop002'])
      core.append({ kind: 'agent_exited', actor: 'stale', ref: id, body: '', meta: {} })
    const ledger = new IntegrityLedger()
    supervisor(probeHolding([OTHER_SESSION]), ledger)

    attach(lead)

    expect(rows(INTEGRITY_READMIT_SKIPPED).map(row => [row.meta?.agent_id, row.meta?.reason])).toEqual([
      [lead, 'lineage unresolved: loops at agloop001'],
    ])
  })
})
