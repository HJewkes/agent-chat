import type { SpawnOptions } from 'node:child_process'

/** Runs one AppleScript and returns its trimmed output. Injected so tests need no macOS. */
export type AppleScriptRunner = (script: string) => string

/** The slice of `child_process.spawn` a surface uses. Injected for the same reason. */
export type SpawnFn = (
  bin: string,
  args: string[],
  options: SpawnOptions,
) => { pid?: number | undefined; unref: () => void }

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
