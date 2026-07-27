import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Deliberately short. Unix socket paths cap near 104 bytes on macOS, which rules
 * out putting the socket next to a project or in a session scratchpad.
 */
export const home = (): string => process.env.AGENT_CHAT_HOME ?? path.join(os.homedir(), '.agent-chat')

export const socketPath = (): string => path.join(home(), 'chat.sock')

export const logPath = (): string => path.join(home(), 'broker.log')

/** Diagnostic only. `service status` answers "is it running" from the socket, never from this. */
export const pidPath = (): string => path.join(home(), 'broker.pid')

/** `{port, version, started}` — what `restart` reads to reuse the port it was on. */
export const metaPath = (): string => path.join(home(), 'broker.meta.json')

/** Shared secret for the loopback HTTP surface, written 0600 alongside the socket. */
export const tokenPath = (): string => path.join(home(), 'broker.token')

/** Built dashboard assets, served by the broker rather than by a separate dev server. */
export const dashboardDir = (): string => path.join(dist(), 'dashboard')

const dist = (): string => path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 7600 is clear on this machine and inside the house 7xxx band: active-work holds
 * 7400, voltras 7723, brain 7800. Loopback only, always.
 */
export const DEFAULT_PORT = 7600

export const defaultPort = (): number => {
  const raw = process.env.AGENT_CHAT_PORT
  if (!raw) return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  // A typo'd override silently binding a random port is worse than ignoring it.
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT
}
