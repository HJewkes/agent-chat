/** How long Claude Code gets to exit on SIGTERM before the ladder reaches SIGKILL. */
export const SESSION_KILL_GRACE_MS = 3000

/**
 * End Claude Code itself: SIGTERM, then SIGKILL after a grace. Shared by the broker, for a
 * session on its own host, and by a session's MCP process ending its own parent (CC-881).
 */
export function endHostSession(name: string, hostPid: number): { ok: boolean; reason?: string } {
  try {
    process.kill(hostPid, 'SIGTERM')
  } catch {
    return { ok: false, reason: `${name} (pid ${hostPid}) was already gone` }
  }
  setTimeout(() => {
    try {
      process.kill(hostPid, 'SIGKILL')
    } catch {
      // exited on the polite signal, which is the good case
    }
  }, SESSION_KILL_GRACE_MS).unref?.()
  return { ok: true }
}
