import os from 'node:os'
import path from 'node:path'

/**
 * Deliberately short. Unix socket paths cap near 104 bytes on macOS, which rules
 * out putting the socket next to a project or in a session scratchpad.
 */
export const home = (): string => process.env.AGENT_CHAT_HOME ?? path.join(os.homedir(), '.agent-chat')

export const socketPath = (): string => path.join(home(), 'chat.sock')

export const logPath = (): string => path.join(home(), 'broker.log')
