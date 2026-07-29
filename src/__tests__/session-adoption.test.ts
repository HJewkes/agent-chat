import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { reapBroker } from './broker-harness.js'
import { EventLog } from '../broker/event-log.js'
import { AgentLog } from '../agents/identity.js'
import { hostIdentity } from '../server/host.js'

/**
 * CC-30 end to end, through a real MCP subprocess and a real broker.
 *
 * What only this level can prove: that `CLAUDE_CODE_SESSION_ID` is actually read
 * from the environment and actually reaches the broker on `register`. A unit
 * test can assert the broker adopts on a session id, and still pass while
 * nothing ever sends one.
 *
 * Runs against built output, so `npm run build` must have happened first.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-adoption-'))
const SESSION_ID = '11111111-2222-3333-4444-555555555555'

const transports: StdioClientTransport[] = []

/** An ORDINARY session: no AGENT_CHAT_* identity, exactly as a human launch has none. */
async function startSession(sessionId: string): Promise<Client> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith('AGENT_CHAT_')) env[key] = value
  env.AGENT_CHAT_HOME = TEST_HOME
  env.CLAUDE_CODE_SESSION_ID = sessionId
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env })
  const client = new Client({ name: 'test-session', version: '0.0.1' }, { capabilities: {} })
  await client.connect(transport)
  transports.push(transport)
  return client
}

const register = (client: Client, name: string) =>
  client.callTool({ name: 'chat_register', arguments: { name, working_on: 'CC-30' } })

function readIdentity(sessionId: string) {
  const log = new EventLog(path.join(TEST_HOME, 'events.db'))
  const agent = new AgentLog(log).bySession(sessionId)
  log.close()
  return agent
}

afterAll(async () => {
  for (const transport of transports) await transport.close().catch(() => undefined)
  await reapBroker(TEST_HOME)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('an ordinary human-started session', () => {
  it('is given a durable identity the moment it registers', async () => {
    const client = await startSession(SESSION_ID)
    await register(client, 'ordinary')

    const agent = readIdentity(SESSION_ID)
    expect(agent).toMatchObject({ name: 'ordinary', origin: 'adopted', state: 'live' })
    // The handle the whole task exists to produce: something the broker can name.
    expect(agent?.agentId).toBeTruthy()
  }, 20_000)

  it('reports its own session id, without the model being asked for it', async () => {
    // chat_register carries a name and a working_on line and nothing else. If
    // this matches, the id came from the process rather than from the caller.
    expect(readIdentity(SESSION_ID)?.sessionId).toBe(SESSION_ID)
  })
})

describe('hostIdentity', () => {
  it('reports the parent process, not this one', () => {
    expect(hostIdentity({ CLAUDE_CODE_SESSION_ID: 'sess' }, 4242)).toEqual({
      sessionId: 'sess',
      hostPid: 4242,
    })
  })

  it('offers no handle once the process has been reparented to init', () => {
    expect(hostIdentity({ CLAUDE_CODE_SESSION_ID: 'sess' }, 1)).toEqual({ sessionId: 'sess' })
  })

  it('offers no session id outside Claude Code, which is an ordinary case', () => {
    expect(hostIdentity({}, 4242)).toEqual({ hostPid: 4242 })
  })
})
