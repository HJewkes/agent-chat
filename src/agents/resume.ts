/**
 * Resume-with-message (R-59): give an existing conversation ONE MORE TURN,
 * without opening a window for a human to type into.
 *
 * The gap this fills. `--resume` on its own is pure mode-switching — the
 * transcript is reattached and the agent picks up exactly where it stopped, with
 * nobody putting anything new in front of it (see `mode-switch.ts`). That is
 * right when the thing to look at is a permission prompt, and useless when the
 * caller has something to SAY: a follow-up question, a correction, a "the build
 * is green, carry on". `claude -p <message> --resume <id>` is the native shape
 * for that, verified against the installed CLI rather than inferred — note that
 * `-p/--print` there is a BOOLEAN, so the message is an ordinary positional
 * prompt that happens to follow it.
 *
 * The same session id, deliberately. The turn is appended to the existing
 * transcript, so the next resume sees it. `--fork-session` would branch a copy
 * instead, which is a different feature (explore an alternative without
 * disturbing the original) and not what a follow-up message wants.
 *
 * Pure by construction, so it can live in the `spawn-kernel` subpath: it builds
 * an argv and returns it. Nothing here reads the environment, touches disk or
 * starts a process — the caller owns all of that, which is exactly the line
 * `spawn-kernel.ts` draws around `run-agent.ts`.
 */

/** An argv a caller can spawn, with no shell and no environment of ours. */
export interface ResumeCommand {
  bin: 'claude'
  args: string[]
}

/**
 * Build `claude -p <message> --resume <sessionId>`.
 *
 * Both arguments are rejected empty rather than passed through: an empty session
 * id resumes the most recent conversation on the machine (`--resume` takes an
 * OPTIONAL value), and an empty message makes `-p` wait on stdin that will never
 * arrive. Both fail as a hang or as the wrong agent answering, which is far more
 * expensive to diagnose than a throw here.
 */
export function resumeWithMessage(sessionId: string, message: string): ResumeCommand {
  if (sessionId.trim() === '') throw new Error('resumeWithMessage needs a session id')
  if (message.trim() === '') throw new Error('resumeWithMessage needs a non-empty message')
  return { bin: 'claude', args: ['-p', message, '--resume', sessionId] }
}
