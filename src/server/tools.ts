import type { BrokerClient } from '../client/broker-client.js'
import {
  DECLARED_MAX_BYTES,
  DECLARED_MAX_KEYS,
  DECLARED_MAX_VALUE_CHARS,
  ISOLATION_NAMES,
  SESSION_STATUSES,
  SURFACE_NAMES,
} from '../protocol.js'
import { observedRegistration } from '../git.js'
import { terminalAnchor } from './anchor.js'
import { hostIdentity } from './host.js'
import { cliEntry } from '../paths.js'
import { verdictLine } from '../agents/resume-session.js'
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
  {
    name: 'agent_spawn',
    description:
      'Spawn a durable agent that runs as its own Claude Code session and joins the bus as an ordinary ' +
      'peer, addressable by name with chat_send. Reach for this — without being asked — when work needs a ' +
      'second, longer-lived context: a review that should run while you keep working, an exploration whose ' +
      "search shouldn't clutter your own context, or a task that must outlive your session. Do NOT spawn " +
      'to parallelise something you could just finish yourself, or to look busy. ' +
      'Register first — the spawn is attributed to you, and a ' +
      'visible agent is placed in YOUR terminal, which the broker resolves from your own registration ' +
      'rather than from anything you pass here. The agent outlives this session: it belongs to the ' +
      'broker, not to you, so spawning is not a way to get work done before your turn ends. The profile ' +
      'decides the model, the tool set and where the agent appears — read agent_profiles before choosing ' +
      'one, and prefer the narrowest that fits.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short handle for the agent, e.g. "auth-review". Must be free.',
        },
        profile: { type: 'string', description: 'Profile name; see agent_profiles for what each grants.' },
        brief: {
          type: 'string',
          description:
            'What the agent should do, in full. It starts with only this — it does not inherit your ' +
            'conversation, so state the task, the context needed to act, and what to report back.',
        },
        surface: {
          type: 'string',
          enum: [...SURFACE_NAMES],
          description:
            "Overrides the profile's surface. Visible surfaces land in your window and can answer " +
            'permission prompts; headless cannot be prompted at all.',
        },
        isolation: {
          type: 'string',
          enum: [...ISOLATION_NAMES],
          description: "Overrides the profile's isolation, e.g. worktree to keep it out of your checkout.",
        },
        cwd: { type: 'string', description: 'Working directory. Defaults to yours.' },
        worktree: {
          type: 'string',
          description:
            'Absolute path of a worktree the TASK SYSTEM already assigned to this work. Pass it when ' +
            'something upstream decided where this task runs — a parent task, a wave plan — rather than ' +
            'letting the profile pick. It is ADOPTED, not created: it must already exist, no branch is ' +
            'made, no worktree-budget slot is taken, and retiring the agent leaves it in place, because ' +
            'sibling agents may still be working in it. Do not pass a path you invented; if nobody ' +
            'assigned a worktree, omit this and let the profile decide.',
        },
        owns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Path globs INSIDE the worktree that this agent owns, e.g. ["src/broker/**", ' +
            '"src/protocol.ts"]. This is what lets several agents share one worktree: each is given a ' +
            'disjoint set of paths, and a spawn overlapping what a live peer already holds is warned ' +
            'about by name. Advisory, like chat_claim — it records who was given what, and cannot stop ' +
            'an agent that writes outside its set.',
        },
        inherit: {
          type: 'string',
          enum: ['context'],
          description:
            'Set to "context" to start the agent from a COPY of YOUR OWN conversation instead of an ' +
            'empty one — the closest thing here to "fork me". It can only ever fork you: there is no ' +
            'field for whose conversation, and a request to fork a peer is refused. Reach for it when ' +
            'the agent needs what you have been doing and re-describing it would cost more than it is ' +
            'worth. KNOW WHAT IT IS NOT: still a separate process paying its own input tokens, so it ' +
            'is not the cheap built-in fork; and it sees only your COMPLETED turns, never the one you ' +
            'are in, so do not refer to work you have not finished narrating. Also weigh what it ' +
            'carries — the agent inherits everything you have said, including anything its profile was ' +
            'never meant to see. A brief is the narrower and usually better tool.',
        },
        resume_session: {
          type: 'string',
          description:
            "A Claude session uuid to CONTINUE instead of starting fresh, e.g. a retired agent's " +
            'session id from agent_list. Its transcript must already exist under the account ' +
            '(config_dir) and cwd the agent will run in; otherwise the spawn is refused and names the ' +
            'path it checked. The brief becomes its next turn. For an agent that is finished but not ' +
            'retired, agent_resume is simpler.',
        },
        predecessor: {
          type: 'string',
          description:
            'Name of an agent YOU spawned whose work this one takes over, for a follow-up assignment ' +
            'sent to a fresh worker instead of the one that did the first piece. The broker adds a ' +
            "section to the brief with the predecessor's last report (its newest chat_send to you), " +
            'its branch and worktree, and its session id and transcript path, so the brief need only ' +
            'say what to do next. Refused for an agent someone else spawned. It does not retire the ' +
            'predecessor: the spawn warns while it is unretired, and retiring it is yours to do once ' +
            'this one registers.',
        },
        config_dir: {
          type: 'string',
          description:
            'Absolute path of the Claude config dir the agent should run under, and therefore WHICH ' +
            'ACCOUNT it spends, e.g. "/Users/you/.claude-profiles/agents". Omit it in the ordinary ' +
            "case: the agent inherits YOUR account automatically, then the briefing initiative's " +
            "declared profile, then the broker's. Pass it only to bill an account deliberately. It " +
            'must already exist and be under your home directory; anything else is refused rather than ' +
            'quietly replaced, because running on the wrong account is the failure this prevents.',
        },
        briefing: {
          type: 'string',
          description:
            'Optional active-work initiative slug (e.g. "claude-channels"), or "auto". The broker reads ' +
            "that initiative's brief.md, open tasks and latest session note and prepends them to your " +
            'brief, so you do not have to re-describe the project — write the ASSIGNMENT in brief and ' +
            'let this carry the orientation. It also asks the active-work daemon for up to six notes, ' +
            'sources, tasks or sessions ranked against your brief text (any initiative, foreign ones ' +
            'labelled) and lists them with absolute paths; if the daemon does not answer within 1 second ' +
            'that list is left out and the spawn carries a warning. So the brief itself is the query: ' +
            'name the specifics. "auto" resolves from your own directory first, then from ' +
            'cwd; if neither is inside an initiative the spawn still succeeds, with a warning and no ' +
            'briefing. Omit it when the work has no active-work initiative behind it.',
        },
      },
      required: ['name', 'profile', 'brief'],
    },
  },
  {
    name: 'agent_teleport',
    description:
      'End this session and start a successor that boots from the CURRENT build, keeping your name, ' +
      'your peers, your tags and your working directory. Use it when your own instructions or the code ' +
      'you run on have moved since you started — the alternative is exiting (losing what you know) or ' +
      'staying useful and stale. BUILD FIRST: the successor execs whatever `npm run build` last ' +
      'produced, so a teleport that skips the build achieves nothing at real cost. This is not a resume ' +
      'and not a subagent: your transcript does not come with you, the handoff below is all your ' +
      'successor gets, and you will be shut down. If you are visible in a terminal, your human gets 30 ' +
      'seconds to stop it; if you are headless it happens immediately. You cannot cancel it yourself. ' +
      'Answer or dismiss any open questions to the human first — teleport refuses while any are open.',
    inputSchema: {
      type: 'object',
      properties: {
        handoff: {
          type: 'string',
          description:
            'Everything your successor needs, written by you, stored verbatim, 8 KB max (refused, not ' +
            'truncated). Cover, in this order: (1) what you were mid-way through, in enough detail to ' +
            'resume without you; (2) state on disk — branch, uncommitted files, what builds and what ' +
            'does not; (3) what you would have done next, and why that and not the alternative; (4) ' +
            'what you already tried that did NOT work, which is the most expensive thing to lose; (5) ' +
            'who you owe a reply to and what you promised; (6) files to read first, in order, as ' +
            '@-prefixed absolute paths — Claude Code expands those into your successor’s first turn, ' +
            'so point at files instead of pasting them.',
        },
        model: {
          type: 'string',
          description:
            'Optional. Omit to keep running on the model you are on now, which is the usual case. Set ' +
            'it only to succeed yourself onto a different one deliberately — a cheaper model for a ' +
            'long grind, a stronger one for what is left.',
        },
      },
      required: ['handoff'],
    },
  },
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
      case 'agent_spawn':
        return this.spawnAgent(args)
      case 'agent_teleport':
        return this.teleport(args)
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

  /**
   * The anchor is deliberately absent from the request. The broker resolves it
   * from THIS session's registry entry, so a spawn cannot be aimed at a pane the
   * caller does not hold — and passing one here would be ignored anyway (§5.4).
   */
  private async spawnAgent(args: Record<string, unknown>) {
    if (this.registeredName === null) {
      return text(
        'Register with chat_register first: a spawn is attributed to the session that asked for it.',
      )
    }
    const surface = optionalEnum(args, 'surface', SURFACE_NAMES)
    const isolation = optionalEnum(args, 'isolation', ISOLATION_NAMES)
    const cwd = optionalString(args, 'cwd')
    const briefing = optionalString(args, 'briefing')
    const worktree = optionalString(args, 'worktree')
    const owns = optionalPatterns(args, 'owns')
    // No companion field for WHOSE context: the broker reads that off this
    // connection, so "fork that agent" has nowhere to be expressed.
    const inherit = optionalEnum(args, 'inherit', ['context'] as const)
    const configDir = optionalString(args, 'config_dir')
    const resumeSession = optionalString(args, 'resume_session')
    const predecessor = optionalString(args, 'predecessor')
    // CC-100: read from THIS process's environment, never from the model. The
    // broker is a detached daemon whose own `CLAUDE_CONFIG_DIR` is an accident of
    // which session autostarted it, so this is the only place the spawning
    // session's account can be observed.
    const spawnerConfigDir = process.env.CLAUDE_CONFIG_DIR
    const res = (await this.call(
      {
        t: 'spawn',
        name: requireString(args, 'name'),
        profile: requireString(args, 'profile'),
        brief: requireString(args, 'brief'),
        ...(configDir === undefined ? {} : { configDir }),
        ...(spawnerConfigDir === undefined ? {} : { spawnerConfigDir }),
        ...(surface === undefined ? {} : { surface }),
        ...(isolation === undefined ? {} : { isolation }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(briefing === undefined ? {} : { briefing }),
        ...(worktree === undefined ? {} : { worktree }),
        ...(owns === undefined ? {} : { owns }),
        ...(inherit === undefined ? {} : { inherit }),
        ...(resumeSession === undefined ? {} : { resumeSession }),
        ...(predecessor === undefined ? {} : { predecessor }),
      },
      'spawn_result',
    )) as Extract<ServerMessage, { t: 'spawn_result' }>

    if (!res.ok) return text(`Not spawned: ${res.reason}`)
    const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
    // Told here, not just in the spawned agent's own brief: a toolset-confined
    // agent cannot report being stuck (the tool is absent from its schema, not
    // refused), so spawn time is the only place this is knowable with certainty.
    const denied = res.disallowedTools?.length ? `\n  denied tools: ${res.disallowedTools.join(', ')}` : ''
    // The one caveat a forking session cannot check for itself: its own current
    // turn is not in the transcript yet, so the fork is behind by whatever this
    // turn has established but not yet said.
    const forked =
      inherit === undefined
        ? ''
        : '\n  it holds a copy of your conversation up to your last COMPLETED turn — not this one'
    const resumed = res.transcript === undefined ? '' : `\n  resumed session: ${verdictLine(res.transcript)}`
    return text(
      `Spawned "${res.name}" (${res.agentId}). It is a peer now — reach it with chat_send, ` +
        `not by spawning again.${forked}${resumed}${warnings}${denied}`,
    )
  }

  /**
   * Hand off and end this session.
   *
   * Nothing here names the subject: the broker resolves it from this
   * connection's own registry entry, which is what makes "teleport someone else"
   * unrepresentable rather than merely refused.
   */
  private async teleport(args: Record<string, unknown>) {
    if (this.registeredName === null) {
      return text(
        'Register with chat_register first: teleport hands your name to a successor, and you do not ' +
          'have one yet.',
      )
    }
    const model = optionalString(args, 'model')
    const res = (await this.call(
      { t: 'teleport', handoff: requireString(args, 'handoff'), ...(model === undefined ? {} : { model }) },
      'teleport_result',
    )) as Extract<ServerMessage, { t: 'teleport_result' }>

    if (!res.ok) return text(`Not teleporting: ${res.reason}`)
    const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
    const when =
      res.countdownMs === undefined
        ? 'Your successor is starting now and this session is being shut down.'
        : `Your human has ${Math.round(res.countdownMs / 1000)}s to stop this, then you will be shut ` +
          'down and your successor will open in the same window.'
    return text(
      `Teleport accepted. Handoff recorded; your successor is ${res.agentId} and keeps the name ` +
        `"${res.name}". ${when} Do not start anything new — finish or write down whatever is in ` +
        `flight, because it will not survive this turn.${warnings}`,
    )
  }
}
