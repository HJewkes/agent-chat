/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SpawnOptions } from 'node:child_process'

/** Runs one AppleScript and returns its trimmed output. Injected so tests need no macOS. */
export type AppleScriptRunner = (script: string) => string

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
