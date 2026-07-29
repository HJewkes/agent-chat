import { isInteractiveSurface, type AgentIdentity, type SurfaceName } from '../protocol.js'

/**
 * Mode switching (CC-23): move a running agent between headless and a terminal
 * window, keeping its identity, its conversation and its place in the roster.
 *
 * It is teleport's shape with the handoff removed and `--resume` in place of
 * `--session-id`. Teleport mints a new conversation and carries a written
 * handoff across the gap; a mode switch carries the conversation ITSELF, because
 * Claude Code can reattach to a transcript written under either surface. Both
 * were verified against the installed CLI before this was built: a `-p`-origin
 * transcript resumes interactively, and an interactive-origin one resumes under
 * `-p`.
 *
 * WHERE THIS DELIBERATELY DIVERGES FROM TELEPORT, and it is the one decision
 * worth reading twice. Teleport's central invariant is that the request NAMES NO
 * AGENT — "teleport someone else" is unrepresentable rather than refused.
 * Surfacing cannot honour that, because the case it exists for is an agent too
 * stuck to ask: CC-2 established that headless sessions relay no permission
 * prompts at all, so a blocked headless agent is invisible to the very view that
 * exists to unblock it. Something outside it has to notice and pull it up.
 *
 * So the two directions have deliberately different reach:
 *
 * - SURFACING may be aimed at another agent. It only ever WIDENS what a human
 *   can see and answer, and it only applies to headless agents — there is no
 *   version of it that hides work or takes a pane away from anyone.
 * - BACKGROUNDING is self-only, with no target field at all, exactly as teleport
 *   is. Sending someone else's pane away is the operation that would let one
 *   peer make another's work invisible, and there is no field to ask for it.
 *
 * WHAT IT COSTS, stated because it is real and the caller should say so: a
 * switch stops the process and resumes from the transcript. An in-flight turn is
 * lost — resume replays the conversation, not the partial turn that was running
 * when the signal arrived.
 */

/** Told to an agent that has just been pulled into a terminal by someone else. */
export const SURFACED_NOTICE = [
  'You were moved from headless into a terminal window so a human can see you and answer anything',
  'you are blocked on. Your identity, name and conversation are unchanged; the turn you were part',
  'way through when this happened was interrupted, so re-check anything you believe you had just',
  'finished. Carry on from here.',
].join(' ')

/** The continuation turn a backgrounded agent resumes on, since `-p` refuses without one. */
export const BACKGROUNDED_BRIEF = [
  'You have been moved out of a terminal window and are now running headless, at your own request.',
  'Your identity, name and conversation are unchanged. Nobody is watching a pane for you now, so',
  'you will not be prompted for permission — anything that would need approval will simply be',
  'denied. Continue the work you were doing, and report progress over agent-chat rather than to a',
  'screen.',
].join(' ')

export interface SwitchOutcome {
  ok: boolean
  reason?: string
  name?: string
  agentId?: string
  /** Where it actually landed, which the placement ladder may have downgraded. */
  surface?: SurfaceName
  warnings?: string[]
}

/**
 * Where a surfaced agent should appear.
 *
 * The human's rule, and it reads as one sentence: an agent that already has a
 * window pulls its peer up BESIDE ITSELF, in that same window; a background
 * agent surfacing itself has no window to be beside, so it opens its own.
 *
 * `iterm-pane` is what "same window" means mechanically — `surfaces/iterm.ts`
 * splits the anchor and then stacks later agents down that column, rather than
 * halving the requester's pane every time.
 *
 * The honest note about the second branch: with no anchor there is no window to
 * put a tab IN, so `iterm-tab` falls down the existing ladder to a new window.
 * That ladder is also the answer to the risk CC-23 flagged as its worst —
 * "the broker has no ITERM_SESSION_ID" — because the fallback needs no anchor
 * and therefore cannot fail to find one. Targeting iTerm's `current window`
 * instead was considered and rejected: it follows user focus, which is the exact
 * bug `iterm.ts` was written to stop.
 */
export function placementFor(anchor: string | undefined): SurfaceName {
  return anchor === undefined ? 'iterm-tab' : 'iterm-pane'
}

/** Shared by both directions: an identity has to be one this broker can relaunch. */
function relaunchable(identity: AgentIdentity | undefined, name: string): string | undefined {
  if (identity === undefined) return `no agent named "${name}"`
  if (identity.origin === 'adopted')
    return (
      `${name} is an ordinary session this broker did not launch, so there is no launch plan to ` +
      'rebuild it from. A session can move itself with agent_teleport instead.'
    )
  if (identity.state === 'retired') return `${name} has been retired`
  return undefined
}

/** Can this agent be pulled into a terminal, and is there any point? */
export function checkSurfaceable(identity: AgentIdentity | undefined, name: string): string | undefined {
  const blocked = relaunchable(identity, name)
  if (blocked) return blocked
  if (isInteractiveSurface((identity as AgentIdentity).surface as SurfaceName))
    return `${name} is already in a terminal; \`agent-chat agent attach ${name}\` goes to it`
  return undefined
}

/**
 * Can this agent send ITSELF headless?
 *
 * `hostPid` is refused rather than worked around for the reason teleport §5.1
 * measured: signalling the MCP subprocess instead of Claude Code severs the bus
 * and leaves a live session no peer can reach and that cannot tell.
 */
export function checkBackgroundable(
  identity: AgentIdentity | undefined,
  name: string,
  hostPid: number | undefined,
): string | undefined {
  const blocked = relaunchable(identity, name)
  if (blocked) return blocked
  if (!isInteractiveSurface((identity as AgentIdentity).surface as SurfaceName))
    return `${name} is already running headless`
  if (hostPid === undefined)
    return (
      'this session did not report the pid of Claude Code itself, so the broker cannot end it ' +
      'without severing the bus and leaving it running. Its MCP server predates this feature — ' +
      'restart the session (or run /mcp reconnect) and try again.'
    )
  return undefined
}
