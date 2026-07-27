/**
 * The terminal this session is sitting in, offered as an anchor for visible spawns.
 *
 * THIS process is the only one that knows it. The broker is started detached with
 * `stdio: 'ignore'` and has no terminal of its own, so the process that does the
 * spawning is structurally not the process that knows where to put a pane — if
 * the anchor does not travel on `register`, it does not exist anywhere.
 *
 * Absent whenever the session is not in iTerm2. That is an ordinary case, not an
 * error: the surface falls back to opening its own window.
 *
 * Its own module rather than part of `index.ts` because `tools.ts` needs it too,
 * and importing `index.ts` from `tools.ts` would close an import cycle.
 */
export function terminalAnchor(env: NodeJS.ProcessEnv = process.env): { termSessionId?: string } {
  const termSessionId = env.ITERM_SESSION_ID
  return termSessionId ? { termSessionId } : {}
}
