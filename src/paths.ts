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

/**
 * Shared secret for the loopback HTTP surface, written 0600 alongside the socket.
 * The unix socket is 0600 so the trust boundary is the OS account; a loopback TCP
 * port is reachable by any local user, which is strictly weaker. This restores parity.
 */
export const tokenPath = (): string => path.join(home(), 'ui.token')

/** Built dashboard assets, served by the broker rather than by a separate dev server. */
export const dashboardDir = (): string => path.join(packageRoot(), 'dashboard')

/**
 * Per-agent working state for agent teams: launch plan, mcp config, isolation
 * handle. The event log stays the source of truth for identity — these are
 * artifacts of a running process, not a parallel store of who exists.
 */
export const agentsDir = (): string => path.join(home(), 'agents')

export const agentDir = (agentId: string): string => path.join(agentsDir(), agentId)

/** User-defined agent profiles, layered over the four builtins. */
export const profilesDir = (): string => path.join(home(), 'profiles')

/** The package root, reached identically from `dist/paths.js` and `src/paths.ts`. */
const packageRoot = (): string => path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Always the built `dist/cli.js`, whether we are running from `dist/` or `src/`.
 *
 * Resolving relative to our own directory looked right and was wrong: from a
 * source-tree run it produced `src/cli.js`, which has never existed. The source
 * tree is not a runnable target either — our internal imports use the TS-ESM
 * `.js` specifier convention (`./broker/index.js`) and Node's type stripping
 * does not rewrite those back to `.ts`, so `node src/cli.ts` dies on the first
 * relative import. `dist/` is the only entry that runs; anchoring on the package
 * root reaches it from both trees.
 *
 * The cost is that a spawn from a source checkout runs whatever `npm run build`
 * last produced, so a stale `dist/` launches stale agents.
 */
export const cliEntry = (): string => path.join(packageRoot(), 'dist', 'cli.js')

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
