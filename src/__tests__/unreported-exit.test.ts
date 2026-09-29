import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import type { DeliveredMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-266 and CC-255: a headless agent that exits without a `Status:` report to
 * its spawner produces an `unreported-exit` message naming its last action.
 * The transcripts are synthetic JSONL written where Claude Code would put them.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let delivered: { conn: Conn; message: DeliveredMessage }[]
let stopAutoAttach: () => void
let exitChild: (code: number) => void

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** A headless child whose exit the test fires, after it has registered. */
const controlledChild = () => ({
  pid: 4242,
  unref: () => undefined,
  once: (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'exit') exitChild = code => listener(code, null)
  },
})

beforeEach(() => {
  process.env.AGENT_CHAT_HOME = tmp('agent-chat-unrep-')
  delivered = []
  const events = new EventLog(path.join(process.env.AGENT_CHAT_HOME, 'events.db'))
  core = new BrokerCore((conn, message) => delivered.push({ conn, message }), {
    events,
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, { surface: { platform: 'linux', spawn: controlledChild } })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function spawnScout(): Promise<string> {
  const result = await supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'do the task',
    requestedBy: 'coord',
    cwd: tmp('agent-chat-ws-'),
    isolation: 'none',
    surface: 'headless',
    spawnerConfigDir: tmp('agent-chat-account-'),
  })
  expect(result.ok).toBe(true)
  await vi.waitFor(() => expect(core.agents.get(result.agentId as string)?.state).toBe('live'))
  return result.agentId as string
}

function writeTranscript(agentId: string, records: object[]): void {
  const agent = core.agents.get(agentId)!
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

const backgroundBash = [
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'gh run watch 99 --exit-status', run_in_background: true },
        },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: b7' },
      ],
    },
  },
]

const unreported = () =>
  core.events.history(200).filter(row => row.kind === 'message' && row.meta.event === 'unreported-exit')

async function exitAndSettle(code = 0): Promise<void> {
  exitChild(code)
  await vi.waitFor(() => expect(core.events.agentEvents().some(r => r.kind === 'agent_exited')).toBe(true))
}

describe('an agent that exits without its Status report', () => {
  it('tells its spawner it exited with a pending background task (CC-255)', async () => {
    const coord = {} as unknown as net.Socket
    core.register(coord, {
      t: 'register',
      name: 'coord',
      workingOn: '',
      cwd: tmp('agent-chat-coord-'),
      pid: 1,
    })
    const agentId = await spawnScout()
    writeTranscript(agentId, backgroundBash)

    await exitAndSettle()

    const [row] = unreported()
    expect(row?.from).toBe('agent-chat')
    expect(row?.meta).toMatchObject({
      target: 'coord',
      agent: 'scout',
      agent_id: agentId,
      last_action: 'Bash(run_in_background)',
      pending_background: 'true',
    })
    expect(row?.text).toBe(
      'scout exited with a pending background task, no final report (no Status report); ' +
        'last action: Bash(run_in_background)',
    )
    expect(row?.text).not.toContain('gh run watch')
    const pushed = delivered.find(d => d.message.event === 'unreported-exit')
    expect(pushed?.conn).toBe(coord)
    expect(pushed?.message.text).toBe(row?.text)
  })

  it('reads last action unknown when the transcript is missing', async () => {
    await spawnScout()

    await exitAndSettle()

    expect(unreported()[0]?.meta.last_action).toBe('unknown')
  })
})

describe('an agent that does not produce the event', () => {
  it('is one that sent its spawner a Status report in this run', async () => {
    const agentId = await spawnScout()
    writeTranscript(agentId, backgroundBash)
    core.append({ kind: 'message', actor: 'scout', target: 'coord', body: 'Status: DONE\nPR: x#1' })

    await exitAndSettle()

    expect(unreported()).toEqual([])
  })

  it('is not one whose only Status report came before it was resumed', async () => {
    const agentId = await spawnScout()
    core.append({ kind: 'message', actor: 'scout', target: 'coord', body: 'Status: DONE' })
    await new Promise(resolve => setTimeout(resolve, 5))
    core.append({ kind: 'agent_resumed', actor: 'coord', ref: agentId })

    await exitAndSettle()

    expect(unreported()).toHaveLength(1)
  })

  it('is not one whose Status report went to someone else', async () => {
    await spawnScout()
    core.append({ kind: 'message', actor: 'scout', target: 'bystander', body: 'Status: DONE' })

    await exitAndSettle()

    expect(unreported()).toHaveLength(1)
  })

  it('is one killed by its owner', async () => {
    await spawnScout()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(supervisor.kill('scout').ok).toBe(true)

    await exitAndSettle(143)

    expect(unreported()).toEqual([])
  })

  it('is one that was retired', async () => {
    await spawnScout()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect((await supervisor.retire('scout')).ok).toBe(true)

    exitChild(0)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(unreported()).toEqual([])
  })
})
