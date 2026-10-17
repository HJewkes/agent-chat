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
import {
  DECLARED_MAX_BYTES,
  DECLARED_MAX_KEYS,
  DECLARED_MAX_VALUE_CHARS,
  type DeclaredPresence,
} from '../protocol.js'

/** The name this session holds; only chat_register changes it, and never for a spawned agent. */
export interface SessionName {
  name(): string | null
  /** True when the name came from the spawn environment rather than the model. */
  fixed: boolean
  adopt(name: string): void
}

/** What a tool's `run` is handed: this session's broker link and the name it holds, if any. */
export interface ToolContext extends BaseContext {
  broker: BrokerClient
  registeredName: string | null
  session: SessionName
  /** The `[budget]` advisory if this session's context newly crossed its mark; the push path draws from the same source. */
  contextHint?: () => string | undefined
}

/** A tool answers with the text the model reads; a refusal is returned, only a failure throws. */
export type Tool<Args> = Command<Args, string, ToolContext>

export const defineTool = <Args>(tool: Tool<Args>): Tool<Args> => defineCommand(tool)

export const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })

/** Names are used verbatim: `chat_send` is already the tool name, with no namespace to add. */
const NAMING = { prefix: '' }

// Compatibility presentation only: validation and authority remain product decisions.
const declaredSchemas = new WeakSet<object>()

export function toolDefinition<Args>(tool: Tool<Args>): McpToolDescriptor {
  const rootSchema: object = tool.args
  return commandToTool(tool, NAMING, {
    // Legacy nested object schemas remain output-shaped; only the stripping root is open.
    io: 'output',
    override: ctx => {
      if (ctx.zodSchema === rootSchema && ctx.jsonSchema.additionalProperties === false)
        delete ctx.jsonSchema.additionalProperties
      if (declaredSchemas.has(ctx.zodSchema)) {
        // Captured tools/list bytes place the description after the declared shape.
        const description = ctx.jsonSchema.description
        delete ctx.jsonSchema.description
        ctx.jsonSchema.type = 'object'
        ctx.jsonSchema.additionalProperties = { type: 'string' }
        if (description !== undefined) ctx.jsonSchema.description = description
      }
    },
  })
}

/** Same contract as ToolHandler.handle: the reply as text content, or a throw the server renders as `Error:`. */
export async function invokeTool<Args>(tool: Tool<Args>, args: Record<string, unknown>, ctx: ToolContext) {
  const { envelope } = await invokeCommand(tool, args, ctx)
  if (!envelope.ok) throw new Error(envelope.error)
  return text(tool.result.parse(envelope.data))
}

const isLabelBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `declared` for chat_register and chat_status: an open bag of short string labels a session asserts
 * about itself, which every peer's chat_list renders. Shape errors reject in the schema.
 */
export const declaredField = (description: string) => {
  const field = z
    .unknown()
    .superRefine((value, ctx) => {
      if (value === null) return
      if (!isLabelBag(value)) {
        ctx.addIssue({
          code: 'custom',
          message: 'declared must be an object of short string labels, e.g. {"role": "implementer"}',
        })
        return
      }
      const nested = Object.keys(value).find(key => typeof value[key] !== 'string')
      if (nested !== undefined)
        ctx.addIssue({
          code: 'custom',
          message: `declared.${nested} must be a string — declared carries labels, not nested structure`,
        })
    })
    .describe(description)
    .optional()
  declaredSchemas.add(field)
  return field
}

/**
 * The labels, with the size caps applied. REJECTS rather than trims: a model that gets an error learns
 * the shape, while one whose bag was quietly truncated believes it declared something it did not.
 * The caps live here, not in the schema, because the published schema has no bounds to match them.
 */
export function declaredLabels(value: unknown): DeclaredPresence | undefined {
  if (!isLabelBag(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )
  if (entries.length > DECLARED_MAX_KEYS)
    throw new Error(`declared may carry at most ${DECLARED_MAX_KEYS} keys; got ${entries.length}`)
  const tooLong = entries.find(([, label]) => label.length > DECLARED_MAX_VALUE_CHARS)
  if (tooLong !== undefined)
    throw new Error(`declared.${tooLong[0]} must be at most ${DECLARED_MAX_VALUE_CHARS} characters`)
  const bytes = entries.reduce(
    (sum, [key, label]) => sum + Buffer.byteLength(key) + Buffer.byteLength(label),
    0,
  )
  if (bytes > DECLARED_MAX_BYTES)
    throw new Error(
      `declared is ${bytes} bytes, over the ${DECLARED_MAX_BYTES}-byte budget. Every session on ` +
        'this machine reads it in chat_list; keep it to short labels.',
    )
  return Object.fromEntries(entries)
}
