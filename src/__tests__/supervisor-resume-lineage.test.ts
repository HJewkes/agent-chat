import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { HUMAN_ROOT, IntegrityLedger } from '../broker/integrity-ledger.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'

/**
 * TP-4313: the integrity ledger forgets every principal at a broker restart, so a child resumed
 * before its parent would latch `unknown parent`. The resume brings the parent back first, or
 * refuses the child without admitting it. Paths, names and ids are synthetic.
 */

const DESK = 'agdesk01'
const tmpDirs: string[] = []
const saved = { home: process.env.HOME }
let core: BrokerCore
let stopAutoAttach: () => void
let exitLatest: () => void
const supervisors: Supervisor[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-lineage-'))
  tmpDirs.push(dir)
  return dir
}

let spawns = 0
const spawnChild = () => ({
  pid: 4242 + spawns++,
  unref: () => undefined,
  once: (event: string, listener: (code: number, signal: null) => void) => {
    if (event === 'exit') exitLatest = () => listener(0, null)
  },
})

/** A broker's supervisor over the shared event log; a new one with a fresh ledger is a restart. */
function supervisorWith(ledger?: IntegrityLedger): Supervisor {
  const supervisor = new Supervisor(core, {
    ...(ledger === undefined ? {} : { integrity: ledger }),
    nameFreeMs: 50,
    launcherRunning: async () => false,
    surface: { platform: 'darwin', spawn: spawnChild as never, runAppleScript: async () => 'fake-pane' },
  })
  supervisors.push(supervisor)
  return supervisor
}

/** The ledger of a broker that has just restarted: only the coordinator's desk was admitted again. */
function restartedLedger(): IntegrityLedger {
  const ledger = new IntegrityLedger()
  const deskFile = path.join(tmpDir(), 'desk-settings.json')
  fs.writeFileSync(deskFile, '{}')
  ledger.admit({ agentId: DESK, parent: HUMAN_ROOT }, () => ({ startup: {}, files: [deskFile] }))
  return ledger
}

beforeEach(() => {
  const home = tmpDir()
  process.env.AGENT_CHAT_HOME = home
  process.env.CLAUDE_CONFIG_DIR = tmpDir()
  process.env.HOME = tmpDir()
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  core.register({} as unknown as net.Socket, {
    t: 'register',
    name: 'coordinator',
    workingOn: '',
    cwd: home,
    pid: 1,
  })
  core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: 'desk',
    msgId: DESK,
    meta: { origin: 'adopted', name: 'desk', cwd: home, depth: '0' },
  })
  fs.mkdirSync(path.join(home, 'profiles'))
  fs.writeFileSync(
    path.join(home, 'profiles', 'lead.json'),
    JSON.stringify({
      role: 'coordinator',
      model: 'opus',
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      isolation: 'none',
      surface: 'headless',
    }),
  )
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  for (const supervisor of supervisors.splice(0)) supervisor.close()
  vi.restoreAllMocks()
  process.env.HOME = saved.home
  delete process.env.AGENT_CHAT_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** `lead` runs the coordinator profile, so it may spawn a child; anything else is an explorer. */
async function spawned(supervisor: Supervisor, name: string, parentAgentId: string): Promise<string> {
  const result = await supervisor.spawn({
    name,
    profile: name === 'lead' ? 'lead' : 'explorer',
    brief: 'read the log',
    cwd: tmpDir(),
    isolation: 'none',
    surface: 'headless',
    requestedBy: 'coordinator',
    parentAgentId,
  })
  if (!result.ok || result.agentId === undefined) throw new Error(`spawn refused: ${result.reason}`)
  return result.agentId
}

/** Ends the newest spawn and leaves its transcript on disk, so it can be resumed. */
async function exitResumable(agentId: string): Promise<void> {
  exitLatest()
  await new Promise(resolve => setImmediate(resolve))
  const agent = core.agents.get(agentId)
  if (agent === undefined) throw new Error('no identity for the spawned agent')
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

/** An exited, resumable agent whose spawn row names `parent`, written straight to the log. */
function recordedExited(agentId: string, name: string, parent: string): void {
  const meta = {
    origin: 'spawned',
    name,
    cwd: tmpDir(),
    session_id: `session-${agentId}`,
    profile: 'explorer',
  }
  core.append({
    kind: 'agent_spawned',
    actor: 'coordinator',
    target: name,
    msgId: agentId,
    meta: { ...meta, parent, depth: '1' },
  })
  core.append({ kind: 'agent_exited', actor: name, ref: agentId, body: '', meta: {} })
  const agent = core.agents.get(agentId)
  if (agent === undefined) throw new Error('no identity for the recorded agent')
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

describe('resume after a broker restart', () => {
  it('resumes an exited parent first, so the child admits under a known parent', async () => {
    const before = supervisorWith()
    const lead = await spawned(before, 'lead', DESK)
    await exitResumable(lead)
    const scout = await spawned(before, 'scout', lead)
    await exitResumable(scout)
    const ledger = restartedLedger()
    const admit = vi.spyOn(ledger, 'admit')

    const outcome = await supervisorWith(ledger).resume('scout', { requestedBy: 'human' })

    expect(outcome).toMatchObject({ ok: true, agentId: scout })
    expect(admit.mock.calls.map(([req]) => req)).toEqual([
      { agentId: lead, parent: DESK, humanProof: false },
      { agentId: scout, parent: lead, humanProof: true },
    ])
    expect(ledger.verdict(lead)).toEqual({ ok: true })
    expect(ledger.verdict(scout)).toEqual({ ok: true })
  })

  it('refuses a child whose parent outlived the restart live, naming it and admitting nothing', async () => {
    const before = supervisorWith()
    const lead = await spawned(before, 'lead', DESK)
    const scout = await spawned(before, 'scout', lead)
    await exitResumable(scout)
    const ledger = restartedLedger()
    const admit = vi.spyOn(ledger, 'admit')

    const outcome = await supervisorWith(ledger).resume('scout', { requestedBy: 'human' })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain(`its parent lead (${lead}) is live but has no baseline in this broker`)
    expect(admit).not.toHaveBeenCalled()
    expect(ledger.verdict(scout)).toEqual({ ok: false, reason: 'no baseline' })
  })

  it('resumes the child of a hand-started session the ledger never admitted, rooted at the human', async () => {
    const before = supervisorWith()
    const scout = await spawned(before, 'scout', DESK)
    await exitResumable(scout)
    const ledger = new IntegrityLedger()
    const admit = vi.spyOn(ledger, 'admit')

    const outcome = await supervisorWith(ledger).resume('scout', { requestedBy: 'human' })

    expect(outcome).toMatchObject({ ok: true, agentId: scout })
    expect(admit.mock.calls.map(([req]) => req)).toEqual([
      { agentId: scout, parent: HUMAN_ROOT, humanProof: true },
    ])
  })

  it('starts no parent for a child its own record refuses', async () => {
    const before = supervisorWith()
    const lead = await spawned(before, 'lead', DESK)
    await exitResumable(lead)
    const scout = await spawned(before, 'scout', lead)
    await exitResumable(scout)
    const child = core.agents.get(scout)
    if (child === undefined) throw new Error('no identity for the child')
    fs.rmSync(transcriptPath(child.cwd, child.sessionId, child.configDir))
    const ledger = restartedLedger()
    const admit = vi.spyOn(ledger, 'admit')
    const spawnsBefore = spawns

    const outcome = await supervisorWith(ledger).resume('scout', { requestedBy: 'human' })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).not.toContain('integrity:')
    expect(admit).not.toHaveBeenCalled()
    expect(spawns).toBe(spawnsBefore)
    expect(core.agents.get(lead)?.state).toBe('exited')
  })

  it('refuses a child whose lineage loops, admitting nothing', async () => {
    stopAutoAttach()
    recordedExited('agloopa1', 'loopa', 'agloopb1')
    recordedExited('agloopb1', 'loopb', 'agloopa1')
    const ledger = restartedLedger()
    const admit = vi.spyOn(ledger, 'admit')

    const outcome = await supervisorWith(ledger).resume('loopa', { requestedBy: 'human' })

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'integrity: loopa is not resumed: its lineage loops at agloopa1',
    })
    expect(admit).not.toHaveBeenCalled()
  })
})
