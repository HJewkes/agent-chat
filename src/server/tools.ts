import type { BrokerClient } from '../client/broker-client.js'
import {
  DECLARED_MAX_BYTES,
  DECLARED_MAX_KEYS,
  DECLARED_MAX_VALUE_CHARS,
  SESSION_STATUSES,
} from '../protocol.js'
import { observedRegistration } from '../git.js'
import { terminalAnchor } from './anchor.js'
import { hostIdentity } from './host.js'
import { cliEntry } from '../paths.js'
import { CLAIM_MAX_PATTERNS } from '../args.js'
import { invokeTool, text, toolDefinition, type ToolContext } from './command.js'
import { chatList } from './commands/chat-list.js'
import { chatSend } from './commands/chat-send.js'
import { agentResume } from './commands/agent-resume.js'
import { agentProfiles } from './commands/agent-profiles.js'
import { agentList } from './commands/agent-list.js'
import { agentBackground } from './commands/agent-background.js'
import { agentSurface } from './commands/agent-surface.js'
import { chatInbox } from './commands/chat-inbox.js'
import { chatActivity } from './commands/chat-activity.js'
import { agentLogs } from './commands/agent-logs.js'
import { chatTranscript } from './commands/chat-transcript.js'
import { sessionBudget } from './commands/session-budget.js'
import { chatBroadcast } from './commands/chat-broadcast.js'
import { chatAsk } from './commands/chat-ask.js'
import { chatEndorse } from './commands/chat-endorse.js'
import { chatNotify } from './commands/chat-notify.js'
import { chatClaim } from './commands/chat-claim.js'
import { chatRelease } from './commands/chat-release.js'
import { chatTag } from './commands/chat-tag.js'
import { chatSubscribe, chatUnsubscribe } from './commands/subscriptions.js'
import { agentSpawn } from './commands/agent-spawn.js'
import { agentTeleport } from './commands/agent-teleport.js'
import { TOOL_COMMANDS } from './commands/index.js'
import type { DeclaredPresence, ServerMessage, SessionStatus } from '../protocol.js'

/**
 * The MCP SDK does not enforce `required` or `enum` on inbound arguments, so a
 * model that omits a field reaches the handler with `undefined`. `String(undefined)`
 * is the non-empty string "undefined", which passes every downstream check — the
 * broker routes it, logs it, and answers ok:true while the recipient is delivered
 * the word "undefined". Observed live on 2026-07-27. Validate at the boundary.
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required and must be a non-empty string`)
  }
  return value
}

/**
 * `declared` for chat_register and chat_status: an open bag of labels a session
 * asserts about itself, validated here for the same reason `requireRecipients`
 * is — the SDK enforces nothing in the schema, so an object of nested objects,
 * or forty keys of prose, would otherwise reach the broker and be rendered into
 * every peer's chat_list.
 *
 * REJECTS rather than silently trims, which is the difference between this and
 * the registry's clamp. A model that gets an error learns the shape; a model
 * whose bag was quietly truncated believes it declared something it did not.
 * Values are narrowed rather than cast (CC-8): this is model-supplied structure.
 */
function optionalDeclared(args: Record<string, unknown>): DeclaredPresence | undefined {
  const value = args.declared
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('declared must be an object of short string labels, e.g. {"role": "implementer"}')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > DECLARED_MAX_KEYS) {
    throw new Error(`declared may carry at most ${DECLARED_MAX_KEYS} keys; got ${entries.length}`)
  }
  const declared: DeclaredPresence = {}
  let bytes = 0
  for (const [key, item] of entries) {
    if (typeof item !== 'string') {
      throw new Error(`declared.${key} must be a string — declared carries labels, not nested structure`)
    }
    if (item.length > DECLARED_MAX_VALUE_CHARS) {
      throw new Error(`declared.${key} must be at most ${DECLARED_MAX_VALUE_CHARS} characters`)
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(item)
    declared[key] = item
  }
  if (bytes > DECLARED_MAX_BYTES) {
    throw new Error(
      `declared is ${bytes} bytes, over the ${DECLARED_MAX_BYTES}-byte budget. Every session on ` +
        'this machine reads it in chat_list; keep it to short labels.',
    )
  }
  return declared
}

/**
 * Claim patterns, or undefined for "the whole worktree" (CC-56).
 *
 * An EMPTY array collapses to undefined rather than erroring, because the two
 * plausible readings of `patterns: []` — claim nothing, claim everything — would
 * both be guesses. Undefined has one documented meaning, so both spellings of
 * "no patterns given" reach it.
 */
function optionalPatterns(args: Record<string, unknown>, key = 'patterns'): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : [value]
  const kept = list.filter(p => typeof p === 'string' && p.trim() !== '') as string[]
  if (kept.length === 0) return undefined
  if (kept.length > CLAIM_MAX_PATTERNS)
    throw new Error(`${key} may name at most ${CLAIM_MAX_PATTERNS} globs; got ${kept.length}`)
  return kept.map(p => p.trim())
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * An absent optional enum is fine; a misspelled one is not. Declaring `enum` in the
 * schema does not enforce it (see above), and silently dropping an unrecognised
 * value would spawn onto the profile default while the caller believes it asked
 * for something else — a headless agent where it wanted an answerable pane.
 */
function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function requireStatus(args: Record<string, unknown>): SessionStatus {
  const value = args.status
  if (typeof value !== 'string' || !(SESSION_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`status must be one of: ${SESSION_STATUSES.join(', ')}`)
  }
  return value as SessionStatus
}

export const TOOL_DEFINITIONS = [
  {
    name: 'chat_register',
    description:
      'Call this FIRST, before your first substantive tool call — before editing files, before spawning ' +
      'anything, before starting independent work. It costs one line and is the only way peers can address ' +
      "you or see you in chat_list; skipping it makes you invisible to anyone checking who's already " +
      "working in this checkout. The name is held until this session exits. If you're unsure whether to " +
      "register, register — it's free, reversible, and the default should be yes.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short handle for this session, e.g. "voltras-ui"' },
        working_on: { type: 'string', description: 'One line on what this session is doing' },
        declared: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional short labels other sessions can filter and read you by, e.g. ' +
            '{"role": "implementer", "initiative": "claude-channels", "task": "CC-11"}. Keys are ' +
            'yours to choose. Peers see these marked as self-reported, so declare what is true. ' +
            `At most ${DECLARED_MAX_KEYS} keys, ${DECLARED_MAX_VALUE_CHARS} characters each. Your ` +
            'branch and checkout are NOT declared here — the server reads those from this process.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'chat_status',
    description:
      'Update what this session is doing and whether it is free to take work. Set dnd to hold ' +
      'incoming pushes when you need a long stretch of focus: nothing is lost, messages collect ' +
      'in your inbox and chat_inbox returns them whenever you next look. Your user can still ' +
      "reach you; other sessions cannot. Set dnd BEFORE a long stretch of focused work you don't " +
      "want interrupted — don't wait until a peer message already derailed you.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['working', 'available', 'blocked'] },
        working_on: { type: 'string', description: 'Optional new description of current work' },
        dnd: {
          type: 'boolean',
          description: 'Hold pushes from other sessions until you clear it. Independent of status.',
        },
        declared: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Replace the self-reported labels from chat_register, e.g. when you move to a new task. ' +
            'This REPLACES the whole set rather than merging, so send every label you still want; ' +
            'an empty object clears them. Omit it to leave them as they are.',
        },
      },
      required: ['status'],
    },
  },
  toolDefinition(chatList),
  toolDefinition(chatClaim),
  toolDefinition(chatRelease),
  toolDefinition(chatSend),
  toolDefinition(chatTag),
  toolDefinition(chatActivity),
  toolDefinition(chatBroadcast),
  toolDefinition(chatAsk),
  toolDefinition(chatEndorse),
  toolDefinition(chatNotify),
  toolDefinition(chatInbox),
  toolDefinition(chatSubscribe),
  toolDefinition(chatUnsubscribe),
  toolDefinition(agentSpawn),
  toolDefinition(agentTeleport),
  toolDefinition(agentSurface),
  toolDefinition(agentResume),
  toolDefinition(agentBackground),
  toolDefinition(agentProfiles),
  toolDefinition(agentList),
  toolDefinition(agentLogs),
  toolDefinition(chatTranscript),
  toolDefinition(sessionBudget),
] as const

/** Tracks the registered name purely so chat_list can mark which entry is us. */
export class ToolHandler {
  private registeredName: string | null
  /** True when the name came from the spawn environment rather than the model. */
  private readonly nameIsFixed: boolean

  /**
   * `spawnedName` seeds the handler for an agent the broker already registered
   * from its environment. Without it the broker knows the agent's name and the
   * handler does not, so `chat_send` would refuse with "call chat_register
   * first" while the agent looked perfectly registered to every peer — visible
   * to everyone, able to answer no one.
   */
  constructor(
    private readonly broker: BrokerClient,
    spawnedName?: string,
    /**
     * A name reclaimed by `readopt` (CC-31), for a session whose MCP subprocess
     * was replaced. Seeded for the same reason as `spawnedName` and NOT fixed:
     * this session chose its own name once and may legitimately choose again,
     * whereas a spawned agent's name was promised to peers before it ran.
     */
    readoptedName?: string,
  ) {
    this.registeredName = spawnedName ?? readoptedName ?? null
    this.nameIsFixed = spawnedName !== undefined
  }

  private async call(
    message: Parameters<BrokerClient['request']>[0],
    replyType: Parameters<BrokerClient['request']>[1],
  ) {
    return this.broker.request(message, replyType)
  }

  private context(): ToolContext {
    return { warnings: [], format: 'human', broker: this.broker, registeredName: this.registeredName }
  }

  async handle(name: string, args: Record<string, unknown>) {
    const tool = TOOL_COMMANDS.get(name)
    if (tool !== undefined) return invokeTool(tool, args, this.context())
    switch (name) {
      case 'chat_register':
        return this.register(
          requireString(args, 'name'),
          optionalString(args, 'working_on') ?? '',
          optionalDeclared(args),
        )
      case 'chat_status':
        return this.status(
          requireStatus(args),
          optionalString(args, 'working_on'),
          typeof args.dnd === 'boolean' ? args.dnd : undefined,
          optionalDeclared(args),
        )
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }

  private async register(name: string, workingOn: string, declared?: DeclaredPresence) {
    // A spawned agent was named by whoever spawned it, and peers have already
    // been told that name. Letting the model rename itself mid-session would
    // strand every one of them, so the call is a no-op rather than a rename.
    if (this.nameIsFixed) {
      if (name === this.registeredName)
        return text(`Already registered as "${name}" by the agent that spawned you.`)
      return text(
        `You are already registered as "${this.registeredName}" (spawned agent); ` +
          'that name is fixed for this session.',
      )
    }

    const res = (await this.call(
      {
        t: 'register',
        name,
        workingOn,
        cwd: process.cwd(),
        pid: process.pid,
        // The half of this registration the model did not choose. `name` and
        // `workingOn` above came from the model; these came from the process,
        // which is what lets the broker mint an identity for an ordinary session
        // without that identity being self-asserted.
        ...hostIdentity(),
        ...terminalAnchor(),
        // CC-11. Derived from this process's directory, never asked of the model:
        // "which checkout am I in" is knowable, and a self-reported answer to a
        // knowable question is a downgrade dressed as a feature.
        ...(await observedRegistration()),
        ...(declared === undefined ? {} : { declared }),
        // CC-36: lets the broker say so when this session's tools come from a
        // different build than the one it is talking to.
        build: cliEntry(),
      },
      'register_result',
    )) as Extract<ServerMessage, { t: 'register_result' }>
    if (!res.ok) return text(`Registration failed: ${res.reason}`)
    // CC-82: the session may already have been registered provisionally by its
    // own MCP server, under a name derived from its directory. Saying so matters
    // — peers may have addressed the old name, and it is about to stop working.
    const renamedFrom =
      this.registeredName !== null && this.registeredName !== name ? this.registeredName : null
    this.registeredName = name
    if (renamedFrom !== null)
      return text(
        `Registered as "${name}", replacing the provisional name "${renamedFrom}" your MCP server ` +
          'assigned from this directory. Peers addressing the old name will need the new one.',
      )
    return text(
      `Registered as "${name}". Other sessions can reach you by that name until this session exits.`,
    )
  }

  private async status(
    status: SessionStatus,
    workingOn?: string,
    dnd?: boolean,
    declared?: DeclaredPresence,
  ) {
    const res = (await this.call(
      {
        t: 'status',
        status,
        ...(workingOn === undefined ? {} : { workingOn }),
        ...(dnd === undefined ? {} : { dnd }),
        ...(declared === undefined ? {} : { declared }),
      },
      'status_result',
    )) as Extract<ServerMessage, { t: 'status_result' }>
    if (!res.ok) return text('Call chat_register first.')
    const quiet =
      dnd === undefined
        ? ''
        : dnd
          ? ' Holding pushes from other sessions; they collect in your inbox.'
          : ' Taking pushes again.'
    return text(`Status set to "${status}".${quiet}`)
  }
}
