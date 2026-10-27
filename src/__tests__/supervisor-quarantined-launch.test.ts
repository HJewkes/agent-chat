import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { HUMAN_ROOT, IntegrityLedger, type AdmitRequest } from '../broker/integrity-ledger.js'
import { hookSettingsPath } from '../agents/launch-files.js'
import { RELAUNCH_RETRY_MS, Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AgentProfile } from '../agents/types.js'

/**
 * TP-4256 A3: every launch the broker writes is admitted by the ledger, exactly once, under the
 * parent the broker recorded, and the broker refuses to start one the ledger denies. Paths, names
 * and ids are synthetic.
 */

const DESK = 'agdesk01'
const MISMATCH = { file: '/synthetic/home/.zshrc', field: 'sha256' }
const tmpDirs: string[] = []
const saved = { home: process.env.HOME }
let core: BrokerCore
let ledger: IntegrityLedger
let supervisor: Supervisor
let stopAutoAttach: () => void
let exitLatest: () => void

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-admit-'))
  tmpDirs.push(dir)
  return dir
}

/** A headless child that never starts anything; `exitLatest` ends the newest one. */
const spawnChild = () => ({
  pid: 4242,
  unref: () => undefined,
  once: (event: string, listener: (code: number, signal: null) => void) => {
    if (event === 'exit') exitLatest = () => listener(0, null)
  },
})

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
  stopAutoAttach = autoAttach(core)
  ledger = new IntegrityLedger()
  const deskFile = path.join(home, 'desk-settings.json')
  fs.writeFileSync(deskFile, '{}')
  ledger.admit({ agentId: DESK, parent: HUMAN_ROOT }, () => ({ startup: {}, files: [deskFile] }))
  supervisor = new Supervisor(core, {
    integrity: ledger,
    nameFreeMs: 50,
    launcherRunning: async () => false,
    surface: {
      platform: 'darwin',
      spawn: spawnChild as never,
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane'),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  vi.restoreAllMocks()
  process.env.HOME = saved.home
  delete process.env.AGENT_CHAT_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const spawnScout = async (over: { requestedBy: string; parentAgentId?: string }): Promise<string> => {
  const result = await supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'read the log',
    cwd: tmpDir(),
    isolation: 'none',
    surface: 'headless',
    ...over,
  })
  return result.ok ? (result.agentId as string) : `refused: ${result.reason}`
}

/** A child of the desk that has exited, with a transcript on disk so it can be resumed. */
async function finishedScout(): Promise<string> {
  const agentId = await spawnScout({ requestedBy: 'coordinator', parentAgentId: DESK })
  exitLatest()
  await new Promise(resolve => setImmediate(resolve))
  const agent = core.agents.get(agentId)
  if (agent === undefined) throw new Error('no identity for the spawned agent')
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
  return agentId
}

const profile: AgentProfile = {
  name: 'inherited',
  description: '',
  model: '',
  allowedTools: [],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: '',
}

/**
 * Resolves true once started. Nothing attaches, so a refused successor is not read as one that
 * attached; it is retried on the clock, so the clock is advanced.
 */
async function relaunchSuccessor(inheritedFrom?: string): Promise<boolean> {
  stopAutoAttach()
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const settled = supervisor
      .relaunch({
        agentId: 'agsucc01',
        name: 'desk',
        profile,
        brief: 'carry on',
        cwd: tmpDir(),
        surface: 'headless',
        preamble: 'you are the continuation',
        meta: { teleport_from: DESK, parent: '' },
        ...(inheritedFrom === undefined ? {} : { inheritedFrom }),
      })
      .then(
        () => true,
        () => false,
      )
    await vi.advanceTimersByTimeAsync(RELAUNCH_RETRY_MS * 3)
    return await settled
  } finally {
    vi.useRealTimers()
  }
}

interface Row {
  path: string
  /** Leaves an agent ready to launch and returns its id; undefined for a launch that mints one. */
  arrange?: () => Promise<string>
  /** The launch; resolves to the agent id it launched, and whether it started. */
  act: (agentId: string) => Promise<{ agentId: string; started: boolean }>
  admitted: (agentId: string) => AdmitRequest
  /** Which principal is quarantined for the refusal half; undefined where nothing can be. */
  quarantine?: 'self' | 'desk'
  startsQuarantined?: true
}

const resumed = (req: Parameters<Supervisor['resume']>[1]) => async (agentId: string) => ({
  agentId,
  started: (await supervisor.resume('scout', req)).ok,
})

const minted = (act: () => Promise<string>) => async () => {
  const agentId = await act()
  return { agentId, started: !agentId.startsWith('refused') }
}

const successor = (inheritedFrom?: string) => async () => ({
  agentId: 'agsucc01',
  started: await relaunchSuccessor(inheritedFrom),
})

const ROWS: Row[] = [
  {
    path: 'spawn by the human',
    act: minted(() => spawnScout({ requestedBy: 'human' })),
    admitted: agentId => ({ agentId, parent: HUMAN_ROOT, humanProof: true }),
  },
  {
    path: 'child spawn',
    act: minted(() => spawnScout({ requestedBy: 'coordinator', parentAgentId: DESK })),
    admitted: agentId => ({ agentId, parent: DESK, humanProof: false }),
    quarantine: 'desk',
  },
  {
    path: 'human resume',
    arrange: finishedScout,
    act: resumed({ requestedBy: 'human' }),
    admitted: agentId => ({ agentId, parent: DESK, humanProof: true }),
    quarantine: 'self',
    startsQuarantined: true,
  },
  {
    path: 'seat or wake resume',
    arrange: finishedScout,
    act: resumed({ requestedBy: 'human', source: 'watchdog' }),
    admitted: agentId => ({ agentId, parent: DESK, humanProof: false }),
    quarantine: 'self',
  },
  {
    path: 'mode switch',
    arrange: () => spawnScout({ requestedBy: 'coordinator', parentAgentId: DESK }),
    act: async agentId => ({
      agentId,
      started: (await supervisor.switchSurface({ name: 'scout', to: 'interactive', requestedBy: 'human' }))
        .ok,
    }),
    admitted: agentId => ({ agentId, parent: DESK }),
    quarantine: 'self',
  },
  {
    path: 'teleport successor that inherits the isolation',
    act: successor(DESK),
    admitted: agentId => ({ agentId, parent: DESK }),
    quarantine: 'desk',
  },
  {
    path: 'teleport successor on a fresh isolation',
    act: successor(),
    admitted: agentId => ({ agentId, parent: DESK }),
    quarantine: 'desk',
  },
]

const settingsOf = (agentId: string): string => fs.readFileSync(hookSettingsPath(agentId), 'utf8')

describe('each broker launch path', () => {
  it.each(ROWS)('$path is admitted once and its settings carry the minted nonce', async row => {
    const ready = (await row.arrange?.()) ?? ''
    const admit = vi.spyOn(ledger, 'admit')

    const { agentId, started } = await row.act(ready)

    expect(started).toBe(true)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(admit.mock.calls[0]?.[0]).toEqual(row.admitted(agentId))
    const { nonce } = admit.mock.results[0]?.value as { nonce: string }
    expect(settingsOf(agentId)).toContain(`leak-guard pretool --integrity '${nonce}'`)
    expect(settingsOf(agentId)).toContain(`leak-guard posttool --integrity '${nonce}'`)
  })

  it.each(ROWS.filter(row => row.quarantine !== undefined))(
    '$path with a quarantined agent or parent starts only on the human resume',
    async row => {
      const ready = (await row.arrange?.()) ?? ''
      ledger.latch(row.quarantine === 'desk' ? DESK : ready, MISMATCH)

      const { agentId, started } = await row.act(ready)

      expect(started).toBe(row.startsQuarantined === true)
      expect(ledger.verdict(agentId).ok).toBe(row.startsQuarantined === true)
    },
  )

  it('tells the human not to run the relaunch script of a refused teleport successor', async () => {
    ledger.latch(DESK, MISMATCH)

    await relaunchSuccessor(DESK)

    const notice = core.events.humanQueue().find(item => item.text.includes('integrity: agsucc01'))
    expect(notice?.text).toContain('do not run its relaunch script')
    expect(notice?.text).not.toContain('in a terminal to start it')
  })
})
