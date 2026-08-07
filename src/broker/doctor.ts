import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import type { HealthPayload } from '../api-contract.js'
import { cliEntry, dashboardDir, defaultPort, home, socketPath } from '../paths.js'
import { probeSocket, readMeta } from './lifecycle.js'
import { newestBuildMtime, stalenessWarning } from './staleness.js'

/**
 * Preflight for the failures that cost real time and give no error.
 *
 * Two of these were paid for the hard way this cycle: the channel allowlist
 * silently dropping every push while the broker still reported `delivered:true`,
 * and the CLI simply not being on `PATH`. Neither produces a message anywhere —
 * which is exactly the class of problem a `doctor` exists to convert into one
 * line of output.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
}

/** macOS caps unix socket paths near this; `paths.ts` is short on purpose. */
const SOCKET_PATH_CAP = 104

const MIN_NODE_MAJOR = 22

/** The marketplace/plugin pair that must be allow-listed for channel pushes to land. */
const CHANNEL_PLUGIN = { marketplace: 'agent-chat-local', plugin: 'agent-chat' }

const MANAGED_SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json'

/**
 * `GET /health` with a hard timeout, returning null for every failure mode.
 *
 * Lives here rather than in the HTTP layer so that nothing which merely *asks*
 * about health has to import a server. Null covers "not answering" and "this
 * build has no HTTP surface" alike — the port bind is best-effort by design.
 */
export async function probeHealth(port: number, timeoutMs = 500): Promise<HealthPayload | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? ((await res.json()) as HealthPayload) : null
  } catch {
    return null
  }
}

function checkNode(): Check {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  return {
    name: 'node',
    status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail:
      major >= MIN_NODE_MAJOR
        ? `v${process.versions.node}`
        : `v${process.versions.node} — node:sqlite needs >=${MIN_NODE_MAJOR}`,
  }
}

function checkStateDir(): Check {
  const dir = home()
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return { name: 'state dir', status: 'ok', detail: `${dir} writable` }
  } catch (err) {
    return { name: 'state dir', status: 'fail', detail: `${dir}: ${(err as Error).message}` }
  }
}

function checkSocketPath(): Check {
  const sock = socketPath()
  const bytes = Buffer.byteLength(sock)
  return {
    name: 'socket path',
    status: bytes < SOCKET_PATH_CAP ? 'ok' : 'fail',
    detail: `${bytes} bytes, cap ~${SOCKET_PATH_CAP} — ${sock}`,
  }
}

function checkDatabase(): Check {
  const file = path.join(home(), 'events.db')
  // Absent is not broken: the first broker start creates it. Opening it here to
  // prove otherwise would create the file and turn a clean install into a lie.
  if (!fs.existsSync(file)) return { name: 'events.db', status: 'warn', detail: `${file} not created yet` }
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => DatabaseSyncType
    }
    const db = new DatabaseSync(file)
    const row = db.prepare('select count(*) as n from events').get() as { n: number } | undefined
    db.close()
    return { name: 'events.db', status: 'ok', detail: `${file} opens, ${row?.n ?? 0} events` }
  } catch (err) {
    return { name: 'events.db', status: 'fail', detail: `${file}: ${(err as Error).message}` }
  }
}

async function checkBroker(live: boolean): Promise<Check[]> {
  const socket: Check = {
    name: 'broker socket',
    status: live ? 'ok' : 'warn',
    detail: live ? `answering on ${socketPath()}` : 'not running — it auto-starts on first use',
  }
  if (!live) return [socket]

  const port = readMeta()?.port ?? defaultPort()
  const health = await probeHealth(port)
  return [
    socket,
    {
      name: 'broker http',
      // A warn, never a fail: the port bind is best-effort and a broker with no
      // HTTP surface at all is a working broker. The socket is what matters.
      status: health ? 'ok' : 'warn',
      detail: health
        ? `/health ok on ${port}, ${health.sessions} sessions`
        : `no /health on ${port} — the HTTP surface may not be bound or not built`,
    },
  ]
}

/** Walks PATH directly rather than shelling out: no subprocess, no quoting question. */
function checkCliOnPath(): Check {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, 'agent-chat')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return { name: 'PATH', status: 'ok', detail: `agent-chat -> ${candidate}` }
    } catch {
      // Not here; keep walking.
    }
  }
  return {
    name: 'PATH',
    status: 'warn',
    detail: 'agent-chat is not on PATH — `npm link` in the repo, or call dist/cli.js directly',
  }
}

function checkBuild(): Check {
  const entry = cliEntry()
  return fs.existsSync(entry)
    ? { name: 'build', status: 'ok', detail: entry }
    : { name: 'build', status: 'fail', detail: `${entry} missing — run npm run build` }
}

/**
 * Is the running broker serving the code that is on disk? (CC-57)
 *
 * A warn rather than a fail, and only when a broker is actually up: a rebuilt
 * `dist/` is a completely normal state for a developer mid-change, and the
 * broker is not broken — it is just older than the tree. What makes it worth
 * saying is that the failure it causes is invisible and permanent per agent.
 */
function checkFreshness(live: boolean): Check[] {
  if (!live) return []
  const meta = readMeta()
  const current = newestBuildMtime()
  if (meta?.buildMtime === undefined || current === null) {
    return [
      {
        name: 'broker fresh',
        status: 'ok',
        detail: 'no build stamp to compare — restart the broker to start tracking',
      },
    ]
  }
  const warning = stalenessWarning(meta.buildMtime, current)
  return [
    {
      name: 'broker fresh',
      status: warning === null ? 'ok' : 'warn',
      detail: warning ?? `serving the current build (${path.basename(current.file)})`,
    },
  ]
}

/** The four-step ladder in `bin/agent-chat-launch.sh`; a miss here breaks the MCP spawn. */
function checkLauncher(): Check {
  const fromHome = readFirstLine(path.join(home(), 'mcp-home'))
  const candidates: [string, string | null][] = [
    ['AGENT_CHAT_ENTRY', process.env.AGENT_CHAT_ENTRY ?? null],
    ['AGENT_CHAT_REPO', process.env.AGENT_CHAT_REPO ? `${process.env.AGENT_CHAT_REPO}/dist/cli.js` : null],
    ['mcp-home', fromHome ? path.join(fromHome, 'dist', 'cli.js') : null],
  ]
  for (const [source, candidate] of candidates) {
    if (candidate === null) continue
    return fs.existsSync(candidate)
      ? { name: 'launcher', status: 'ok', detail: `${source} -> ${candidate}` }
      : { name: 'launcher', status: 'fail', detail: `${source} points at ${candidate}, which does not exist` }
  }
  return { name: 'launcher', status: 'warn', detail: 'falling back to PATH; set ~/.agent-chat/mcp-home' }
}

function readFirstLine(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}

/**
 * The check that justifies the command.
 *
 * Per commit a027926: with this entry absent the broker still reports
 * `delivered:true` while the peer session sees no `<channel>` tag at all. Silent,
 * and expensive to diagnose from either end.
 */
function checkChannelAllowlist(): Check {
  const files = [MANAGED_SETTINGS, path.join(os.homedir(), '.claude', 'settings.json')]
  for (const file of files) {
    if (allowlistHas(file)) return { name: 'channel allowlist', status: 'ok', detail: `listed in ${file}` }
  }
  return {
    name: 'channel allowlist',
    status: 'fail',
    detail:
      `${CHANNEL_PLUGIN.plugin}@${CHANNEL_PLUGIN.marketplace} is not in allowedChannelPlugins — ` +
      'pushes are dropped silently while the broker still reports delivered:true',
  }
}

function allowlistHas(file: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      allowedChannelPlugins?: unknown[]
    }
    return (parsed.allowedChannelPlugins ?? []).some(entry => {
      // Both spellings are accepted in the wild: an object pair, or the
      // "plugin@marketplace" string form.
      if (typeof entry === 'string') return entry === `${CHANNEL_PLUGIN.plugin}@${CHANNEL_PLUGIN.marketplace}`
      const pair = entry as { marketplace?: string; plugin?: string }
      return pair.marketplace === CHANNEL_PLUGIN.marketplace && pair.plugin === CHANNEL_PLUGIN.plugin
    })
  } catch {
    return false
  }
}

function checkDashboard(): Check {
  const index = path.join(dashboardDir(), 'index.html')
  return fs.existsSync(index)
    ? { name: 'dashboard', status: 'ok', detail: index }
    : { name: 'dashboard', status: 'warn', detail: 'not built — the CLI is fully usable without it' }
}

export async function runChecks(): Promise<Check[]> {
  // Probed once and shared: two checks need the answer, and asking twice would
  // let them disagree about whether a broker exists.
  const live = await probeSocket()
  return [
    checkNode(),
    checkStateDir(),
    checkSocketPath(),
    checkDatabase(),
    ...(await checkBroker(live)),
    checkCliOnPath(),
    checkBuild(),
    ...checkFreshness(live),
    checkLauncher(),
    checkChannelAllowlist(),
    checkDashboard(),
  ]
}

export const worstStatus = (checks: Check[]): CheckStatus =>
  checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok'
