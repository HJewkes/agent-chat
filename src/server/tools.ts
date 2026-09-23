import type { BrokerClient } from '../client/broker-client.js'
import { invokeTool, toolDefinition, type ToolContext } from './command.js'
import { chatRegister } from './commands/chat-register.js'
import { chatStatus } from './commands/chat-status.js'
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

export const TOOL_DEFINITIONS = [
  toolDefinition(chatRegister),
  toolDefinition(chatStatus),
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

  private context(): ToolContext {
    return {
      warnings: [],
      format: 'human',
      broker: this.broker,
      registeredName: this.registeredName,
      session: {
        name: () => this.registeredName,
        fixed: this.nameIsFixed,
        adopt: name => {
          this.registeredName = name
        },
      },
    }
  }

  async handle(name: string, args: Record<string, unknown>) {
    const tool = TOOL_COMMANDS.get(name)
    if (tool === undefined) throw new Error(`unknown tool: ${name}`)
    return invokeTool(tool, args, this.context())
  }
}
