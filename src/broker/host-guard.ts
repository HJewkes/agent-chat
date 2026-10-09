import os from 'node:os'
import { logEvent } from './log.js'

/** A pid names a process only on the machine that minted it, so this is the machine's identity. */
export function brokerHost(): string {
  return os.hostname()
}

/**
 * Whether a session reported the broker's own host. A session with no recorded host
 * (an older client) is NOT local: signalling a pid we cannot place is the failure
 * CC-880 measured, so doubt falls on not signalling.
 */
export function isLocalHost(host: string | undefined): boolean {
  return host !== undefined && host === brokerHost()
}

/** The one place a session's pid is signalled; refuses and logs when the pid is not on this host. */
export function signalSessionPid(
  name: string,
  pid: number,
  signal: NodeJS.Signals,
  host: string | undefined,
): { ok: boolean; reason?: string } {
  if (!isLocalHost(host)) {
    const reason =
      `${name} (pid ${pid}) is on host ${host ?? 'unknown'}, not this broker's host ` +
      `${brokerHost()}, so it was not signalled`
    logEvent('signal_refused_remote_host', {
      name,
      pid,
      signal,
      host: host ?? null,
      brokerHost: brokerHost(),
    })
    return { ok: false, reason }
  }
  try {
    process.kill(pid, signal)
  } catch {
    return { ok: false, reason: `${name} (pid ${pid}) was already gone` }
  }
  return { ok: true }
}
