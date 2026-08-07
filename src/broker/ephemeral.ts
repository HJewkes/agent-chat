import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Reap a broker that was started for a throwaway home (CC-76).
 *
 * `watchSocket` already ends a broker whose socket was UNLINKED, which covers a
 * temp directory that got cleaned up. It does not cover the commoner case: a
 * temp directory that was simply LEAKED. The socket is still there, so that
 * guard never fires, and the broker runs until the machine reboots. Two were
 * found six days old; running the CC-75 verification stranded two more inside a
 * minute.
 *
 * The obvious rule — exit when idle — is WRONG for the shared broker, which
 * legitimately sits at zero connections for days (it was at zero after three
 * and a half days up when this was written). So idleness alone cannot be the
 * trigger. What separates the two is not how busy they are but what they are
 * FOR: a broker under the system temp directory belongs to one run of something
 * and has no reason to outlive it, while `~/.agent-chat` is the machine's bus
 * and is supposed to wait around for its next client.
 *
 * Hence the gate is the home's LOCATION, checked once at startup, and the idle
 * timer only ever runs for an ephemeral one.
 */

/**
 * Resolved so `/var/folders/...` and `/private/var/folders/...` compare equal
 * on macOS, where the system temp root is a symlink.
 *
 * Falls back to the nearest ANCESTOR that does exist rather than to the raw
 * path. Resolving one side of the comparison and not the other is worse than
 * resolving neither: the temp root always exists and so always resolves, so a
 * home that does not exist yet would be compared unresolved against a resolved
 * root and never match, which is precisely the case this must get right — the
 * home is created during startup.
 */
const canonical = (target: string): string => {
  const full = path.resolve(target)
  for (let dir = full; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync(dir), path.relative(dir, full))
    } catch {
      // Root is its own parent, so this terminates whatever is missing.
      if (path.dirname(dir) === dir) return full
    }
  }
}

/**
 * Whether `dir` is a per-run directory under the system temp root.
 *
 * The temp root ITSELF is deliberately not ephemeral: `AGENT_CHAT_HOME=/tmp` is
 * a strange thing to do, but it is a stable location a human chose, not a
 * directory some test minted and forgot.
 */
export function isEphemeralHome(dir: string, tmp: string = os.tmpdir()): boolean {
  const target = canonical(dir)
  const root = canonical(tmp)
  if (target === root) return false
  return target.startsWith(root + path.sep)
}

/**
 * How long an ephemeral broker may sit with nothing connected before exiting.
 *
 * Generous on purpose. A broker is auto-started BEFORE its first client
 * connects, so anything short would race the very connection it exists to
 * serve; and a test that pauses between operations must not have the broker
 * vanish underneath it. Exiting late costs a few idle minutes, exiting early
 * costs a confusing failure.
 */
export const IDLE_EXIT_MS = 120_000

/** Rarely, because this is a reaper: nothing depends on noticing promptly. */
export const IDLE_CHECK_MS = 15_000

export interface IdleWatch {
  /** Open socket connections right now. */
  connections: () => number
  idleMs?: number
  checkMs?: number
  now?: () => number
  /** Called once, with how long it had been idle, when the deadline passes. */
  onIdle: (idleForMs: number) => void
}

/**
 * Exit once nothing has been connected for `idleMs`.
 *
 * Tracks the last time a connection was SEEN rather than counting empty polls,
 * so the deadline means the same thing however often the check runs — and a
 * client that connects and leaves between two polls still pushes it out.
 */
export function watchIdle({
  connections,
  idleMs = IDLE_EXIT_MS,
  checkMs = IDLE_CHECK_MS,
  now = Date.now,
  onIdle,
}: IdleWatch): () => void {
  let lastBusy = now()
  const timer = setInterval(() => {
    if (connections() > 0) {
      lastBusy = now()
      return
    }
    const idleFor = now() - lastBusy
    if (idleFor < idleMs) return
    clearInterval(timer)
    onIdle(idleFor)
  }, checkMs)
  // Never hold the process open on its own: if everything else has finished,
  // the reaper has nothing left to reap.
  timer.unref?.()
  return () => clearInterval(timer)
}
