import { isProcessAlive } from './lifecycle.js'

/**
 * Opt-in only: the vitest globalSetup sets this to its own pid, so a broker a test
 * started dies with the test run instead of reparenting to launchd (CC-435).
 * A broker started by hand, by launchd or by a session never has it, and never watches.
 */
export const EXIT_WITH_PID_VAR = 'AGENT_CHAT_EXIT_WITH_PID'

/** Well inside the 10 s a test broker may outlive its run. */
export const WATCH_INTERVAL_MS = 2_000

/** The pid to outlive no longer than one interval, or null when the variable is absent or malformed. */
export function watchedPid(env: NodeJS.ProcessEnv): number | null {
  const raw = env[EXIT_WITH_PID_VAR]
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const pid = Number(raw)
  return pid > 1 ? pid : null
}

export interface ParentWatchDeps {
  isAlive?: (pid: number) => boolean
  onGone?: () => void
  intervalMs?: number
}

/** SIGTERM to ourselves, so the broker's own shutdown handler tidies the socket and state files. */
const terminateSelf = (): void => {
  process.kill(process.pid, 'SIGTERM')
}

/** Starts the watch when the env asks for one; returns a stop function, or null when it did nothing. */
export function exitWithWatchedPid(env: NodeJS.ProcessEnv, deps: ParentWatchDeps = {}): (() => void) | null {
  const pid = watchedPid(env)
  if (pid === null) return null
  const isAlive = deps.isAlive ?? isProcessAlive
  const onGone = deps.onGone ?? terminateSelf
  const timer = setInterval(() => {
    if (isAlive(pid)) return
    clearInterval(timer)
    onGone()
  }, deps.intervalMs ?? WATCH_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
