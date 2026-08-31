/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SpawnOptions } from 'node:child_process'

/**
 * Runs one AppleScript and resolves with its trimmed output. Injected so tests
 * need no macOS.
 *
 * Async because the only caller runs inside the broker, and the broker is one
 * event loop serving every session on the machine. A synchronous `osascript`
 * stopped it dead for as long as iTerm2 took to answer — measured at five
 * seconds during a burst of spawns, which is long enough for a sibling agent's
 * MCP server to give up registering and exit.
 */
export type AppleScriptRunner = (script: string) => Promise<string>

/**
 * The slice of `child_process.spawn` a surface uses. Injected for the same reason.
 *
 * `once` is here because the supervisor infers a headless agent's exit from the
 * child itself — the one surface class that can, since a visible agent's process
 * belongs to a terminal rather than to us. A fake that omitted it would let a
 * test pass while the real exit path was never wired.
 */
export interface SpawnedChild {
  pid?: number | undefined
  unref: () => void
  once: (event: string, listener: (...args: any[]) => void) => unknown
}

export type SpawnFn = (bin: string, args: string[], options: SpawnOptions) => SpawnedChild

export interface SurfaceOptions {
  /**
   * The requester's `ITERM_SESSION_ID`, carried from its registry entry — the
   * broker has none of its own (§5.4). Absent means "no anchor", which is a
   * normal case, not an error: the window surface needs none.
   */
  anchor?: string
  /**
   * The pane of the last agent already stacked beside this anchor, if any. A new
   * agent splits THAT rather than the anchor, so the coordinator's pane is not
   * halved once per spawn. Resolved by the supervisor, which is the only thing
   * that knows which agents are live and where they were put.
   */
  columnAfter?: string
  /**
   * Put the agent IN the anchor session rather than beside it.
   *
   * Only teleport sets this, and only because a teleport's anchor is the
   * predecessor's OWN pane, which it has just vacated — so the descendant takes
   * the place its predecessor held instead of appearing as a new tab next to a
   * pane sitting at a dead shell prompt. Never set for a spawn: an agent must
   * not be able to type into a pane somebody else is working in, and the anchor
   * of a spawn is the REQUESTER's live pane.
   */
  reuseAnchor?: boolean
  /** Told when a surface silently downgrades, e.g. the anchor pane has closed. */
  onNotice?: (message: string) => void
  runAppleScript?: AppleScriptRunner
  spawn?: SpawnFn
  platform?: NodeJS.Platform
}

/**
 * The surface cannot present the agent at all — as opposed to presenting it
 * somewhere less specific. Distinct from a plain Error so the supervisor can
 * append `agent_spawn_refused` rather than treating it as a crash.
 */
export class SurfaceRefused extends Error {
  override readonly name = 'SurfaceRefused'
}
