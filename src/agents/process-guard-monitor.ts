import type { ProcRow } from '../broker/reaper.js'
import { isKnownDaemon } from './orphan-reap.js'
import { runawayVictims, type ProcessGuardMode, type Victim } from './process-guard.js'

/**
 * CC-495: polls the process table and stops a runaway agent-descended process before it takes the
 * machine into swap. Kills only in `kill` mode, which the owner sets in config; `log` (the default)
 * records `process_over_limit` and signals nothing. The mode and limit are read every tick, so
 * flipping the mode needs no broker restart. Every descendant of a `claude` process counts, owner
 * sessions included, which is why killing is opt-in: see docs/process-guard.md.
 */

export const PROCESS_GUARD_INTERVAL_MS = 2_000
/** A pid slow to die is killed again after this, rather than logged on every tick. */
const KILL_REPEAT_MS = 10_000
/** One row per standing runaway per window, not thirty a minute. */
const RECORD_REPEAT_MS = 10 * 60_000
const READER_FAILURE_REPEAT_MS = 60_000
const LOGGED_COMMAND_MAX = 200

export interface GuardDeps {
  readTable: () => Promise<ProcRow[]>
  kill: (pid: number) => void
  log: (event: string, detail: Record<string, unknown>) => void
  mode: () => ProcessGuardMode
  limitBytes: () => number
  now: () => number
  brokerPid: number
  uid: number
}

export interface GuardState {
  lastReaderFailureAt?: number
  /** The mode the quiet windows were set under. */
  lastMode?: ProcessGuardMode
  /** Pid to the time it may next be acted on. Only ever suppresses: victims come from the fresh table. */
  quietUntil: Map<number, number>
}

/** One tick. Never throws for a failed read or a failed kill. */
export async function guardOnce(deps: GuardDeps, state: GuardState): Promise<void> {
  const mode = deps.mode()
  if (mode === 'off') return
  let rows: ProcRow[]
  try {
    rows = await deps.readTable()
  } catch (err) {
    noteReaderFailure(deps, state, err)
    return
  }
  const now = deps.now()
  const limitBytes = deps.limitBytes()
  forgetStale(state, mode, now)
  for (const victim of runawayVictims(rows, limitBytes, { brokerPid: deps.brokerPid, uid: deps.uid })) {
    if (state.quietUntil.has(victim.row.pid)) continue
    const detail = describe(victim, limitBytes, mode)
    const quietFor = act(deps, victim, mode, detail)
    state.quietUntil.set(victim.row.pid, now + quietFor)
  }
}

/** A log-mode window must not delay the first kill after the owner flips to kill (or back). */
function forgetStale(state: GuardState, mode: ProcessGuardMode, now: number): void {
  if (state.lastMode !== mode) state.quietUntil.clear()
  state.lastMode = mode
  for (const [pid, until] of state.quietUntil) if (until <= now) state.quietUntil.delete(pid)
}

/** Kills or only records one victim, logs which, and returns how long to leave the pid alone. */
function act(
  deps: GuardDeps,
  victim: Victim,
  mode: ProcessGuardMode,
  detail: Record<string, unknown>,
): number {
  // CC-898's rule: agent-chat's own broker, launchers and MCP servers, and tmux, are never signalled.
  const daemon = isKnownDaemon(victim.row.command)
  if (mode !== 'kill' || daemon) {
    deps.log('process_over_limit', daemon ? { ...detail, spared: 'agent-chat or host daemon' } : detail)
    return RECORD_REPEAT_MS
  }
  let error: string | undefined
  try {
    deps.kill(victim.row.pid)
  } catch (err) {
    error = (err as NodeJS.ErrnoException).code ?? String(err)
  }
  deps.log('process_killed', error === undefined ? detail : { ...detail, error })
  return KILL_REPEAT_MS
}

function describe(victim: Victim, limitBytes: number, mode: ProcessGuardMode): Record<string, unknown> {
  const { row, root } = victim
  return {
    pid: row.pid,
    ppid: row.ppid,
    rssBytes: row.rssKb * 1024,
    limitBytes,
    command: row.command.slice(0, LOGGED_COMMAND_MAX),
    root: { pid: root.pid, command: root.command.slice(0, LOGGED_COMMAND_MAX) },
    mode,
  }
}

function noteReaderFailure(deps: GuardDeps, state: GuardState, err: unknown): void {
  const now = deps.now()
  if (state.lastReaderFailureAt !== undefined && now - state.lastReaderFailureAt < READER_FAILURE_REPEAT_MS) {
    return
  }
  state.lastReaderFailureAt = now
  deps.log('process_guard_reader_failed', { error: String(err) })
}

/** Ticks on an unref'd interval, never overlapping. Returns its cancel. */
export function startProcessGuard(deps: GuardDeps, intervalMs = PROCESS_GUARD_INTERVAL_MS): () => void {
  const state: GuardState = { quietUntil: new Map() }
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    // A failed tick must never take the broker down.
    void guardOnce(deps, state)
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
