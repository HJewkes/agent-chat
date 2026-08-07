import fs from 'node:fs'
import path from 'node:path'
import { distDir } from '../paths.js'

/**
 * Notice when the broker is running code older than what is on disk (CC-57).
 *
 * A daemon loads its code once, at boot. Rebuild `dist/` underneath it and it
 * keeps serving the old code indefinitely, with nothing anywhere saying so —
 * and because argv is fixed at spawn time, an agent it launches BAKES IN the
 * stale behaviour permanently. That is not hypothetical: CC-47 denied
 * AskUserQuestion on every profile, was correctly merged and correctly
 * compiled, and two of three peers spawned that session called
 * AskUserQuestion anyway, because the broker that wrote their argv had been
 * running since before the build.
 *
 * The failure is silent in both directions — the fix looks applied (it is, in
 * `dist/`) and the agent looks wrong (it is not, it is obeying an older
 * contract). Converting that into one line of warning is the whole job here.
 *
 * Deliberately NOT an auto-restart: registrations are in-memory, so restarting
 * unprompted would drop every live session's registration to fix a problem that
 * might not affect the work in flight. The human decides when to take that hit.
 */

export interface BuildStamp {
  /** Newest mtime found, in epoch ms. */
  mtimeMs: number
  /** The file carrying it, so a warning can say what changed. */
  file: string
}

/**
 * The dashboard is a separate build artifact with its own asset pipeline, and
 * nothing under it changes how the broker behaves or what argv it writes. Left
 * in, a dashboard-only rebuild would raise a staleness warning that is true but
 * irrelevant — which is the fastest way to teach someone to ignore the warning.
 */
const IGNORED_DIRS = new Set(['dashboard'])

/**
 * Newest mtime among the compiled modules the broker actually loads.
 *
 * Only `.js`: source maps and declarations are rewritten by the same build but
 * are never loaded, so including them would widen the window for no signal.
 * Returns null for a missing or unreadable tree — "cannot tell" must never
 * present as "stale".
 */
export function newestBuildMtime(dir: string = distDir()): BuildStamp | null {
  let newest: BuildStamp | null = null

  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      try {
        const { mtimeMs } = fs.statSync(full)
        if (newest === null || mtimeMs > newest.mtimeMs) newest = { mtimeMs, file: full }
      } catch {
        // A file that vanished mid-walk is a build in progress, not an error.
      }
    }
  }

  walk(dir)
  return newest
}

/**
 * Whether the build has moved since the broker loaded it.
 *
 * `loadedMs` is what the broker stamped at boot rather than its process start
 * time. The two are nearly the same, but only the stamp is a statement about
 * the CODE — a process start time invites the question of what happened in
 * between, and answers it wrongly if a build lands during startup.
 *
 * Unknown on either side is NOT stale. A broker whose meta predates this
 * feature, or a tree that cannot be read, must stay quiet: a staleness warning
 * that fires without evidence is worse than none, because it is the kind that
 * gets ignored.
 */
export function isStale(loadedMs: number | undefined, current: BuildStamp | null): boolean {
  if (loadedMs === undefined || current === null) return false
  return current.mtimeMs > loadedMs
}

/** One line, naming the remedy — a warning without the next move is just noise. */
export function stalenessWarning(loadedMs: number | undefined, current: BuildStamp | null): string | null {
  if (!isStale(loadedMs, current) || current === null || loadedMs === undefined) return null
  const minutes = Math.max(1, Math.round((current.mtimeMs - loadedMs) / 60_000))
  return (
    `This broker is running code older than dist/ — ${path.basename(current.file)} was rebuilt ` +
    `${minutes} minute${minutes === 1 ? '' : 's'} after the broker loaded. A spawned agent's argv is ` +
    `fixed at spawn time, so it will carry the OLD behaviour permanently even after a later restart. ` +
    `Run \`agent-chat service restart\` and spawn again if the rebuild matters.`
  )
}
