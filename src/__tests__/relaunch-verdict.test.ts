import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgentVerb } from '../agents/launch-agent.js'
import { askBroker, relaunchRefusal, type AskRelaunch } from '../agents/relaunch-integrity.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { HUMAN_ROOT, type Parent } from '../broker/integrity-ledger.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ServerMessage } from '../protocol.js'

/** TP-4256 A3 S4: `run-agent` asks the ledger's verdict and refuses on every failure. Ids and paths are synthetic. */

const dirs: string[] = []
const servers: SocketServer[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A broker whose agents root sits under a fresh AGENT_CHAT_HOME, never the live one. */
function setup() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-relaunch-')))
  dirs.push(home)
  vi.stubEnv('AGENT_CHAT_HOME', home)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  servers.push(server)
  const agentDir = (agentId: string): string => path.join(home, 'agents', agentId)
  const admit = (agentId: string, parent: Parent, name = 'plan.json'): { plan: string } => {
    const plan = path.join(agentDir(agentId), name)
    fs.mkdirSync(path.dirname(plan), { recursive: true })
    fs.writeFileSync(plan, JSON.stringify({ args: ['--settings', 'settings.json'] }))
    server.integrity.admit({ agentId, parent }, () => ({ startup: {}, files: [plan] }))
    return { plan }
  }
  const relaunch = (agentId: string, dir: string = agentDir(agentId)) => {
    const frames: ServerMessage[] = []
    const conn = {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    server.handleMessage(conn, { t: 'integrity_relaunch', agentId, agentDir: dir })
    return frames.at(-1) as Extract<ServerMessage, { t: 'integrity_relaunch_result' }>
  }
  const ask: AskRelaunch = agentId => Promise.resolve(relaunch(agentId))
  return { home, server, admit, relaunch, ask }
}

/** process.exit stubbed to throw, so the verb stops where the real one would. */
function trapExit() {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`exit ${String(code)}`)
  })
  return { stderr, exit }
}

describe('run-agent relaunch verdict', () => {
  it('exits 77 and points at agent resume when the broker cannot be reached', async () => {
    setup()
    const { stderr, exit } = trapExit()

    await expect(runAgentVerb('a1', askBroker)).rejects.toThrow('exit 77')

    expect(exit).toHaveBeenCalledWith(77)
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/could not be asked.*agent-chat agent resume/s)
  })

  it('refuses an agent the ledger does not know', async () => {
    const { ask } = setup()

    await expect(relaunchRefusal('a1', ask)).resolves.toMatch(/refused it: no baseline/)
  })

  it('refuses a plan.json stripped of --settings since the last tick, because the sweep runs first', () => {
    const { admit, relaunch } = setup()
    const { plan } = admit('a1', HUMAN_ROOT)

    fs.writeFileSync(plan, JSON.stringify({ args: [] }))

    expect(relaunch('a1')).toMatchObject({ ok: false, reason: 'quarantined', file: plan, field: 'sha256' })
  })

  it('refuses a child of a quarantined parent, admitted before the parent latched', async () => {
    const { admit, server, ask } = setup()
    admit('p1', HUMAN_ROOT)
    admit('c1', 'p1')

    server.integrity.latch('p1', { file: '/home/example/.zshrc', field: 'sha256' })

    await expect(relaunchRefusal('c1', ask)).resolves.toMatch(/quarantined: \/home\/example\/.zshrc changed/)
  })

  it('launches a clean agent: the gate passes and the verb goes on to read the plan', async () => {
    const { admit, ask } = setup()
    admit('a1', HUMAN_ROOT, 'settings.json')
    trapExit()

    await expect(relaunchRefusal('a1', ask)).resolves.toBeUndefined()
    await expect(runAgentVerb('a1', ask)).rejects.toThrow(/no launch plan for agent a1/)
  })

  it('answers offBroker only for a dir outside the agents root, judged by path not by text', () => {
    const { home, relaunch } = setup()

    expect(relaunch('a1', path.join(home, 'remote', 'agents', 'a1'))).toMatchObject({
      ok: true,
      offBroker: true,
    })
    expect(relaunch('a1', `${home}/agents-x/a1`)).toMatchObject({ ok: true, offBroker: true })
    expect(relaunch('a1', `${home}/remote/../agents/a1`)).toMatchObject({ ok: false, reason: 'no baseline' })
  })
})
