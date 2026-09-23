import { createRegistry } from '@titan-design/registry'
import type { ToolContext } from '../command.js'
import { chatList } from './chat-list.js'
import { chatSend } from './chat-send.js'
import { agentResume } from './agent-resume.js'

/** Tools already defined through the registry; ToolHandler routes these names here before its switch. */
export const TOOL_COMMANDS = createRegistry<ToolContext>()
TOOL_COMMANDS.register(chatList)
TOOL_COMMANDS.register(chatSend)
TOOL_COMMANDS.register(agentResume)
