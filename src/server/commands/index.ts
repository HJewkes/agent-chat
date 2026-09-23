import { createRegistry } from '@titan-design/registry'
import type { ToolContext } from '../command.js'
import { chatList } from './chat-list.js'
import { chatSend } from './chat-send.js'
import { agentResume } from './agent-resume.js'
import { agentProfiles } from './agent-profiles.js'
import { agentList } from './agent-list.js'
import { agentBackground } from './agent-background.js'
import { agentSurface } from './agent-surface.js'
import { chatInbox } from './chat-inbox.js'
import { chatActivity } from './chat-activity.js'
import { agentLogs } from './agent-logs.js'
import { chatTranscript } from './chat-transcript.js'
import { sessionBudget } from './session-budget.js'
import { chatBroadcast } from './chat-broadcast.js'
import { chatAsk } from './chat-ask.js'
import { chatEndorse } from './chat-endorse.js'
import { chatNotify } from './chat-notify.js'
import { chatClaim } from './chat-claim.js'
import { chatRelease } from './chat-release.js'
import { chatTag } from './chat-tag.js'
import { chatSubscribe, chatUnsubscribe } from './subscriptions.js'
import { agentSpawn } from './agent-spawn.js'
import { agentTeleport } from './agent-teleport.js'
import { chatRegister } from './chat-register.js'
import { chatStatus } from './chat-status.js'

/** Every MCP tool; ToolHandler routes each call by name through this registry. */
export const TOOL_COMMANDS = createRegistry<ToolContext>()
TOOL_COMMANDS.register(chatList)
TOOL_COMMANDS.register(chatSend)
TOOL_COMMANDS.register(agentResume)
TOOL_COMMANDS.register(agentProfiles)
TOOL_COMMANDS.register(agentList)
TOOL_COMMANDS.register(agentBackground)
TOOL_COMMANDS.register(agentSurface)
TOOL_COMMANDS.register(chatInbox)
TOOL_COMMANDS.register(chatActivity)
TOOL_COMMANDS.register(agentLogs)
TOOL_COMMANDS.register(chatTranscript)
TOOL_COMMANDS.register(sessionBudget)
TOOL_COMMANDS.register(chatBroadcast)
TOOL_COMMANDS.register(chatAsk)
TOOL_COMMANDS.register(chatEndorse)
TOOL_COMMANDS.register(chatNotify)
TOOL_COMMANDS.register(chatClaim)
TOOL_COMMANDS.register(chatRelease)
TOOL_COMMANDS.register(chatTag)
TOOL_COMMANDS.register(chatSubscribe)
TOOL_COMMANDS.register(chatUnsubscribe)
TOOL_COMMANDS.register(agentSpawn)
TOOL_COMMANDS.register(agentTeleport)
TOOL_COMMANDS.register(chatRegister)
TOOL_COMMANDS.register(chatStatus)
