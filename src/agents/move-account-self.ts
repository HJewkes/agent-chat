import type { SessionInfo } from '../protocol.js'

/**
 * CC-1592: the one roster row a Claude Code session id names, so the human's command moves the
 * session it was typed in without anyone typing a name. Never a guess: none or several refuse.
 */
export function selfSession(
  sessions: readonly SessionInfo[],
  sessionId: string | undefined,
): { name: string } | { error: string } {
  if (sessionId === undefined || sessionId === '')
    return { error: 'CLAUDE_CODE_SESSION_ID is not set, so this is not a Claude Code session; pass --name' }
  const names = sessions.filter(s => s.observed?.claudeSessionId === sessionId).map(s => s.name)
  const [only, ...rest] = names
  if (only === undefined)
    return { error: `no live session reports Claude Code session ${sessionId}; pass --name` }
  if (rest.length > 0)
    return {
      error: `${names.length} live sessions report Claude Code session ${sessionId} (${names.join(', ')}); pass --name`,
    }
  return { name: only }
}
