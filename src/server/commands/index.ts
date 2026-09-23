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

/** Tools already defined through the registry; ToolHandler routes these names here before its switch. */
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
