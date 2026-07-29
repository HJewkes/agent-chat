/**
 * What this process knows about the Claude Code session it belongs to, without
 * asking the model anything.
 *
 * Both fields answer questions the broker cannot answer for itself and the model
 * must not be trusted to answer for it. They travel on `register`, next to
 * `terminalAnchor()`, for the same structural reason: the broker runs detached
 * and has neither this environment nor this process tree.
 *
 * `CLAUDE_CODE_SESSION_ID` is set in every agent-chat MCP subprocess (verified
 * with `ps eww` across five live subprocesses on 2026-07-28). It is the id
 * `transcript.ts` derives a transcript path from, so recording it makes an
 * ordinary session's transcript findable exactly the way a spawned agent's
 * already is.
 *
 * `process.ppid` is Claude Code itself: every one of those five subprocesses had
 * a parent whose command was `claude`. It is a HANDLE, not a licence — the
 * parent is whatever launched this process, and nothing may signal it without
 * first establishing that killing it is the intended act.
 */
export interface HostIdentity {
  sessionId?: string
  hostPid?: number
}

export function hostIdentity(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid): HostIdentity {
  const sessionId = env.CLAUDE_CODE_SESSION_ID
  return {
    ...(sessionId ? { sessionId } : {}),
    // 1 means this process was reparented to init, so its parent is already gone
    // and the handle would point at something that is not the session.
    ...(Number.isInteger(ppid) && ppid > 1 ? { hostPid: ppid } : {}),
  }
}
