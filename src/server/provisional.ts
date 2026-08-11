import path from 'node:path'
import { RESERVED_NAMES } from '../protocol.js'

/**
 * A name for a session that never asked for one (CC-82).
 *
 * WHY THIS EXISTS. `chat_register` is a tool the MODEL calls, so a session is
 * addressable only if its model complied with an instruction. Measured on this
 * machine 2026-08-11: four live sessions, every one with a healthy MCP
 * subprocess holding broker sockets, none of them in `chat_list` — including the
 * session that was diagnosing the problem. Two had never registered in their
 * lives; one had registered twelve days earlier, in a different session.
 *
 * The argument is not new here. `server/index.ts` already makes it for spawned
 * agents, in those words: waiting for the model "would make peer reachability
 * depend on it complying with an instruction — a race that will sometimes lose,
 * and which fails by leaving the agent invisible to everyone told to talk to
 * it." A spawned agent gets its name from its launch plan. An ordinary session
 * has no launch plan, so the name has to be derived — and derivation is the only
 * part of this that is new.
 *
 * PROVISIONAL, AND SAID SO. A derived name is not a chosen one, and a peer must
 * be able to tell the difference: "relay" here means "a session running in the
 * relay directory", not "a session that calls itself relay". `chat_register`
 * later RENAMES rather than being refused, and that rename is the session
 * declaring an identity for the first time.
 */

/** Bounded, lowercase, and shaped like something a person would have typed. */
const MAX_LENGTH = 24

const sanitize = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, MAX_LENGTH)

/**
 * An active-work initiative directory, which is the best answer available.
 *
 * A session bootstrapped on an initiative has that initiative's directory as its
 * cwd from the moment it starts — before any command runs, which is what makes
 * it usable at MCP startup. It is also the name a human would have picked: the
 * three unregistered sessions measured would have become `relay`, `logan` and
 * `claude-channels`, which is exactly what they were.
 */
export function activeWorkSlug(cwd: string): string | undefined {
  const parts = cwd.split(path.sep)
  const at = parts.lastIndexOf('active-work')
  const slug = at === -1 ? undefined : parts[at + 1]
  return slug === undefined || slug === '' ? undefined : sanitize(slug)
}

/**
 * The repository, for a session working in a checkout rather than an initiative.
 *
 * The WORKTREE's basename rather than the repository's, deliberately: two
 * sessions in two worktrees of one repo are the case where telling them apart
 * matters most, and `agent-chat` vs `agent-chat` helps nobody.
 */
const fromWorktree = (worktreePath: string | undefined): string | undefined =>
  worktreePath === undefined ? undefined : sanitize(path.basename(worktreePath))

/**
 * Derive a provisional name, best source first. Never returns a reserved name:
 * `human`, `system` and friends carry authority in every peer's reading of
 * `from`, and a directory that happens to be called `system` must not be able to
 * mint that by accident.
 */
export function provisionalName(input: {
  cwd: string
  worktreePath?: string | undefined
}): string | undefined {
  const candidates = [
    activeWorkSlug(input.cwd),
    fromWorktree(input.worktreePath),
    sanitize(path.basename(input.cwd)),
  ]
  return candidates.find(name => name !== undefined && name !== '' && !RESERVED_NAMES.has(name))
}

/**
 * A second name to try when the first is already held by a live session.
 *
 * Two sessions in one directory is ordinary — a human in a checkout and an agent
 * beside them — so a collision must not cost the second one its registration.
 * The suffix comes from the session id rather than a counter, so the same
 * session lands on the same name across a reconnect instead of drifting.
 */
export function disambiguated(name: string, sessionId: string | undefined, pid: number): string {
  const seed = sessionId ?? String(pid)
  const suffix = seed
    .replace(/[^a-z0-9]/gi, '')
    .slice(-4)
    .toLowerCase()
  return `${name.slice(0, MAX_LENGTH - suffix.length - 1)}-${suffix}`
}
