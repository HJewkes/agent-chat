import path from 'node:path'
import type { ClientMessage } from '../protocol.js'
import type { BrokerCore } from './core.js'
import type { RecoveredBy, StoredHandoff } from './handoffs.js'
import { logEvent } from './log.js'

/**
 * CC-524: a handoff whose successor never registered is shown to the next session
 * that could act on it.
 *
 * A teleport ends the predecessor before its successor starts, so a successor that
 * never boots leaves the handoff in the log with no reader. The next session to
 * register the same name, or to start in the same directory, gets it as a message
 * from the broker. That message cites the handoff row and says which match it was,
 * which is what stops a second showing on the same match. A directory showing never
 * uses up the name's: two seats can share a directory, and the handoff is the name's.
 */

/** Older than this, a handoff describes work nobody should resume from on its say-so. */
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/** A successor gets this long to register before a session in its directory is shown its handoff. */
export const CWD_GRACE_MS = 2 * 60_000

export interface HandoffMatch {
  handoff: StoredHandoff
  by: RecoveredBy
}

type Registration = Pick<Extract<ClientMessage, { t: 'register' }>, 'name' | 'cwd' | 'agentId' | 'sessionId'>

export interface RecoveryOptions {
  now?: number
  /** `returningSession` as read before this registration, which mints an identity for a new session. */
  returning?: boolean
}

/**
 * Whether this session already had an identity, so it is re-registering rather than
 * starting. Read BEFORE `core.register`, which adopts a session that has none.
 */
export const returningSession = <C>(core: BrokerCore<C>, msg: Registration): boolean =>
  msg.sessionId !== undefined && core.agents.bySession(msg.sessionId) !== undefined

const sameDir = (a: string | undefined, b: string): boolean =>
  a !== undefined && a !== '' && path.resolve(a) === path.resolve(b)

/**
 * The undelivered handoff this registration should be shown, newest first.
 *
 * A name match needs no wait: whoever holds the name is where the answer to "what was
 * this session doing" is expected. A directory match waits out the grace, goes to one
 * session only, and never to a broker-spawned agent (it has a brief of its own) or to a
 * session that was already running (it did not start there, it re-registered).
 */
export function undeliveredFor<C>(
  core: BrokerCore<C>,
  msg: Registration,
  { now = Date.now(), returning = false }: RecoveryOptions = {},
): HandoffMatch | undefined {
  const open = core.events.undeliveredHandoffs(now - RECOVERY_MAX_AGE_MS)
  const named = open.find(h => h.name === msg.name)
  if (named !== undefined) return { handoff: named, by: 'name' }
  if (msg.agentId !== undefined || returning) return undefined
  const settled = open.filter(h => !h.shownInCwd && h.at <= now - CWD_GRACE_MS)
  const here = settled.find(h => sameDir(core.agents.get(h.predecessorId)?.cwd, msg.cwd))
  return here === undefined ? undefined : { handoff: here, by: 'cwd' }
}

export function recoveryText({ handoff, by }: HandoffMatch): string {
  const why =
    by === 'name'
      ? `you registered the name ${handoff.name}`
      : `you started in ${handoff.name}'s working directory`
  return [
    `Undelivered handoff. ${handoff.name} teleported at ${new Date(handoff.at).toISOString()} and its ` +
      `successor never registered, so it never read what follows. The broker is showing it to you because ` +
      `${why}. ${handoff.name} wrote it about its own mid-flight state and nothing verifies it against the ` +
      'disk. If this work is not yours, tell the human instead of acting on it. ' +
      `Print it again with: agent-chat handoff last ${handoff.name}`,
    handoff.text,
  ].join('\n\n')
}

/** Show `msg`'s session the undelivered handoff it matches, once. Call after its registration succeeded. */
export function recoverHandoff<C>(
  core: BrokerCore<C>,
  msg: Registration,
  options: RecoveryOptions = {},
): boolean {
  const match = undeliveredFor(core, msg, options)
  if (match === undefined) return false
  const text = recoveryText(match)
  const { msgId } = core.append({
    kind: 'message',
    actor: 'agent-chat',
    target: msg.name,
    ref: match.handoff.msgId,
    body: text,
    meta: { recovered_by: match.by },
  })
  core.deliverTo(msg.name, { msgId, from: 'agent-chat', text, at: options.now ?? Date.now() })
  logEvent('handoff_recovered', {
    name: msg.name,
    handoff: match.handoff.msgId,
    from: match.handoff.name,
    by: match.by,
  })
  return true
}
