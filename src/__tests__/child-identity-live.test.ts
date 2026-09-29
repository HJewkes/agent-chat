import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { reapBroker } from './broker-harness.js'
import { EventLog } from '../broker/event-log.js'
import { AgentLog } from '../agents/identity.js'

/**
 * CC-174, over real processes: an agent runs `claude` from its own shell, the
 * child inherits the agent's identity environment, and must not displace it.
 *
 * This process stands in for the agent's Claude Code, so its parent stands in
 * for run-agent. The child's MCP server runs under `sh`, the way a nested
 * `claude` runs under the agent's Bash tool, so its host is not run-agent's child.
 *
 * Runs against built output, so `npm run build` must have happened first.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-child-identity-'))
const AGENT_ID = 'ci000001'
const NAME = 'parent-agent'

const transports: StdioClientTransport[] = []

const identityEnv = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  AGENT_CHAT_HOME: TEST_HOME,
  AGENT_CHAT_AGENT_ID: AGENT_ID,
  AGENT_CHAT_NAME: NAME,
  AGENT_CHAT_LAUNCHER_PID: String(process.ppid),
})

async function connect(command: string, args: string[]): Promise<void> {
  const transport = new StdioClientTransport({ command, args, env: identityEnv() })
  const client = new Client({ name: 'test-child-identity', version: '0.0.1' }, { capabilities: {} })
  await client.connect(transport)
  transports.push(transport)
}

const startParent = (): Promise<void> => connect(process.execPath, [CLI, 'mcp'])

/** `; exit` keeps sh from exec-ing node, so sh stays the MCP server's host. */
const startNestedChild = (): Promise<void> =>
  connect('/bin/sh', ['-c', `"${process.execPath}" "${CLI}" mcp; exit $?`])

const settle = (ms = 800): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const agentRows = (kind: string): number => {
  const log = new EventLog(path.join(TEST_HOME, 'events.db'))
  const rows = log.agentEvents().filter(r => r.ref === AGENT_ID && r.kind === kind)
  log.close()
  return rows.length
}

beforeAll(() => {
  const log = new EventLog(path.join(TEST_HOME, 'events.db'))
  log.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: NAME,
    msgId: AGENT_ID,
    body: 'run a nested claude',
  })
  log.close()
})

afterAll(async () => {
  for (const transport of transports) await transport.close().catch(() => undefined)
  await reapBroker(TEST_HOME)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('a claude started from inside an agent', () => {
  it('leaves the agent registered instead of superseding it', async () => {
    await startParent()
    await settle()
    expect(agentRows('agent_attached')).toBe(1)

    await startNestedChild()
    await settle(2000)

    expect(agentRows('agent_attached')).toBe(1)
    expect(agentRows('agent_detached')).toBe(0)
    const log = new EventLog(path.join(TEST_HOME, 'events.db'))
    expect(new AgentLog(log).get(AGENT_ID)?.state).toBe('live')
    log.close()
  }, 20_000)

  it('still lets a fresh launch of the same agent take over a live connection', async () => {
    await startParent()
    await settle()

    expect(agentRows('agent_attached')).toBe(2)
    expect(agentRows('agent_detached')).toBe(1)
  }, 20_000)
})
