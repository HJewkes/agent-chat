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
 * The resume takeover, end to end over real sockets and the real reconnect
 * ladder. This has to be an integration test: the bug it exists to catch is a
 * two-process ping-pong, and a unit test with fake connections has neither the
 * second process nor the ladder that drives it.
 *
 * Runs against built output, so `npm run build` must have happened first.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-takeover-'))
const AGENT_ID = 'tk000001'

const transports: StdioClientTransport[] = []

/** Launch an MCP server carrying spawn identity in its environment, as a launch plan will. */
async function startAgent(name: string, agentId: string = AGENT_ID): Promise<StdioClientTransport> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: {
      ...process.env,
      AGENT_CHAT_HOME: TEST_HOME,
      AGENT_CHAT_AGENT_ID: agentId,
      AGENT_CHAT_NAME: name,
    },
  })
  const client = new Client({ name: `test-${name}`, version: '0.0.1' }, { capabilities: {} })
  await client.connect(transport)
  transports.push(transport)
  return transport
}

const readLog = () => new EventLog(path.join(TEST_HOME, 'events.db'))

const settle = (ms = 600): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const attachCount = (): number => {
  const log = readLog()
  const rows = log.agentEvents().filter(r => r.ref === AGENT_ID && r.kind === 'agent_attached')
  log.close()
  return rows.length
}

beforeAll(() => {
  // Mint the identity the way A3's supervisor eventually will. Written before
  // any broker starts, so the first registration can already resolve it.
  const log = readLog()
  log.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: 'scout',
    msgId: AGENT_ID,
    body: 'take part in a takeover',
  })
  log.close()
})

afterAll(async () => {
  for (const transport of transports) await transport.close().catch(() => undefined)
  await reapBroker(TEST_HOME)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('a resume takeover', () => {
  it('settles on exactly one holder instead of trading the name forever', async () => {
    await startAgent('scout')
    await settle()
    expect(attachCount()).toBe(1)

    await startAgent('scout')
    await settle()

    // The regression: the displaced process used to hit its reconnect ladder,
    // replay its registration with the same agentId, and take the name straight
    // back — each side a legitimate holder by the takeover rule, forever. The
    // count is what catches it; the lifecycle alone would look fine either way.
    expect(attachCount()).toBe(2)

    // Long enough for several rungs of the ladder, which is where a ping-pong
    // would show up.
    await settle(2000)
    expect(attachCount()).toBe(2)

    const log = readLog()
    expect(new AgentLog(log).get(AGENT_ID)?.state).toBe('live')
    log.close()
  }, 20_000)

  it('refuses an id claimed under a name it was not spawned under', async () => {
    await startAgent('impostor')
    await settle()

    const log = readLog()
    const attachedNames = log
      .agentEvents()
      .filter(r => r.ref === AGENT_ID && r.kind === 'agent_attached')
      .map(r => r.actor)
    log.close()

    expect(attachedNames).not.toContain('impostor')
  }, 20_000)
})
