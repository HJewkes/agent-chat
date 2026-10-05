import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { serveTools } from '../server/index.js'
import { TOOL_CATALOGUE_MAX_BYTES, ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'

/**
 * Every session pays for the tool catalogue in context before it does anything (CC-667),
 * so its size has a ceiling. Measured as the JSON bytes of the tools a client lists.
 */

async function listedTools(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
  const server = new Server({ name: 'agent-chat', version: '0.1.0' }, { capabilities: { tools: {} } })
  serveTools(server, new ToolHandler({} as BrokerClient))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'budget', version: '0.0.0' })
  await client.connect(clientSide)
  return (await client.listTools()).tools
}

const bytes = (s: string): number => Buffer.byteLength(s)

describe('the MCP tool catalogue', () => {
  it('stays under its byte ceiling', async () => {
    const tools = await listedTools()

    const size = bytes(JSON.stringify(tools))
    const largest = tools
      .map(tool => ({ name: tool.name, bytes: bytes(tool.description ?? '') }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5)
      .map(tool => `${tool.name} ${tool.bytes} B`)
      .join(', ')
    expect(
      size,
      `catalogue is ${size} B, over ${TOOL_CATALOGUE_MAX_BYTES} B; largest descriptions: ${largest}`,
    ).toBeLessThanOrEqual(TOOL_CATALOGUE_MAX_BYTES)
  })
})
