import {
  commandToTool,
  defineCommand,
  invokeCommand,
  type BaseContext,
  type Command,
  type McpToolDescriptor,
} from '@titan-design/registry'
import { z } from 'zod'
import type { BrokerClient } from '../client/broker-client.js'

/** What a tool's `run` is handed: this session's broker link and the name it holds, if any. */
export interface ToolContext extends BaseContext {
  broker: BrokerClient
  registeredName: string | null
}

/** A tool answers with the text the model reads; a refusal is returned, only a failure throws. */
export type Tool<Args> = Command<Args, string, ToolContext>

export const defineTool = <Args>(tool: Tool<Args>): Tool<Args> => defineCommand(tool)

/** Rejects blank as well as absent: `String(undefined)` once reached a peer as the word "undefined". */
export const nonBlank = (message: string) =>
  z.string({ error: message }).refine(value => value.trim() !== '', message)

export const requiredString = (field: string) =>
  nonBlank(`${field} is required and must be a non-empty string`)

export const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })

/** Names are used verbatim: `chat_send` is already the tool name, with no namespace to add. */
const NAMING = { prefix: '' }

export function toolDefinition<Args>(tool: Tool<Args>): McpToolDescriptor {
  const { name, description, inputSchema } = commandToTool(tool, NAMING)
  // registry 0.2.0 closes the root object, which no hand-written tool did and zod does not enforce.
  const { additionalProperties, ...open } = inputSchema
  return { name, description, inputSchema: additionalProperties === false ? open : inputSchema }
}

/** Same contract as ToolHandler.handle: the reply as text content, or a throw the server renders as `Error:`. */
export async function invokeTool<Args>(tool: Tool<Args>, args: Record<string, unknown>, ctx: ToolContext) {
  const { envelope } = await invokeCommand(tool, args, ctx)
  if (!envelope.ok) throw new Error(envelope.error)
  return text(tool.result.parse(envelope.data))
}
