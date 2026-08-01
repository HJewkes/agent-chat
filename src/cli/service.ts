import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { HealthPayload } from '../api-contract.js'
import { probeHealth } from '../broker/doctor.js'
import { isProcessAlive, probeSocket, readMeta, readPidFile, removeStateFiles } from '../broker/lifecycle.js'
import { cliEntry, defaultPort, logPath, socketPath } from '../paths.js'
import { type ServerMessage } from '../protocol.js'
import { withBroker } from './client.js'

/** How long `stop` waits for a polite exit before it stops being polite. */
const TERM_GRACE_MS = 3_000

export interface ServiceStatus {
  /** Authoritative liveness: something answered on the unix socket. */
  socket: boolean
  /** Diagnostic only — a PID file survives `kill -9`, so it never answers "is it running". */
  pid: number | null
  meta: ReturnType<typeof readMeta>
  /** Null when the HTTP surface did not answer, which is a legible state, not a failure. */
  health: HealthPayload | null
}

/**
 * Three-stage, extending active-work's two-stage (§4.3). Each stage is collected
 * separately so "running but HTTP down" stays legible instead of collapsing into
 * one boolean.
 */
export async function collectStatus(port?: number): Promise<ServiceStatus> {
  const socket = await probeSocket()
  const meta = readMeta()
  const health = await probeHealth(port ?? meta?.port ?? defaultPort())
  return { socket, pid: readPidFile(), meta, health }
}

export async function status(options: { port?: number }): Promise<void> {
  const s = await collectStatus(options.port)
  console.log(`socket   ${s.socket ? 'up' : 'down'}  ${socketPath()}`)
  console.log(
    s.pid === null
      ? 'pid      no pid file'
      : `pid      ${s.pid}${isProcessAlive(s.pid) ? '' : ' (stale — no such process)'}`,
  )
  if (s.meta) {
    console.log(`meta     version ${s.meta.version}  port ${s.meta.port ?? 'unbound'}`)
  }
  console.log(
    s.health === null
      ? 'http     no answer'
      : `http     ok  uptime ${Math.round(s.health.uptime_ms / 1000)}s  ` +
          `${s.health.sessions} sessions  ${s.health.queue_open} open`,
  )
  // The socket is the answer to "is it running"; nothing else here is.
  if (!s.socket) process.exit(1)
}

/** Attached sessions at stop time, or null when the broker is already unreachable. */
async function attachedSessions(): Promise<number | null> {
  try {
    const res = (await withBroker(b => b.request({ t: 'list' }, 'list_result'))) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    return res.sessions.length
  } catch {
    return null
  }
}

export async function start(options: { port?: number; foreground?: boolean }): Promise<void> {
  if (await probeSocket()) {
    console.log(`Already running — something is answering on ${socketPath()}.`)
    return
  }
  const port = options.port
  if (options.foreground) {
    // Exactly what `agent-chat broker` has always done, and still the same code
    // path: the hidden alias and this flag must not drift apart.
    if (port !== undefined) process.env.AGENT_CHAT_PORT = String(port)
    const { startBroker } = await import('../broker/index.js')
    const server = await startBroker()
    if (!server) console.error(`a broker is already listening on ${socketPath()}`)
    return
  }

  // Detached, matching `spawnBroker` (`broker-client.ts:90`) — the broker must
  // outlive whichever process happened to want it first.
  const env = port === undefined ? process.env : { ...process.env, AGENT_CHAT_PORT: String(port) }
  spawn(process.execPath, [cliEntry(), 'broker'], { detached: true, stdio: 'ignore', env }).unref()

  const up = await waitFor(() => probeSocket(), TERM_GRACE_MS)
  if (!up) {
    console.error(`Started, but nothing is answering on ${socketPath()} yet. Check: agent-chat service logs`)
    process.exit(1)
  }
  const meta = readMeta()
  console.log(`Broker up on ${socketPath()}${meta?.port ? ` and port ${meta.port}` : ''}.`)
}

export async function stop(): Promise<void> {
  const attached = await attachedSessions()
  const pid = readPidFile()
  if (pid === null || !isProcessAlive(pid)) {
    removeStateFiles()
    console.log('Not running (no live pid). State files cleared.')
    return
  }

  process.kill(pid, 'SIGTERM')
  const exited = await waitFor(async () => !isProcessAlive(pid), TERM_GRACE_MS)
  if (!exited) {
    process.kill(pid, 'SIGKILL')
    console.log(`Broker ${pid} ignored SIGTERM for ${TERM_GRACE_MS / 1000}s; killed.`)
  } else {
    console.log(`Stopped broker ${pid}.`)
  }
  removeStateFiles()

  // §4.4: stop is not sticky. Any live session's MCP subprocess reconnects and
  // resurrects the broker within ~100ms, so with sessions attached this was
  // functionally a restart. Saying so beats letting the user rediscover it.
  if (attached !== null && attached > 0) {
    console.log(
      `${attached} session${attached === 1 ? ' was' : 's were'} attached — ` +
        'each will auto-restart the broker on its next message. `stop` is not sticky.',
    )
  }
}

export async function restart(options: { port?: number }): Promise<void> {
  const previous = readMeta()?.port ?? undefined
  await stop()
  // §4.5: the registry is in-memory, so process lifetime IS the registration
  // lease. Everything durable survives; presence does not, briefly.
  console.log('Registrations are in-memory: every session shows as reconnecting for a few seconds.')
  const port = options.port ?? previous
  await start(port === undefined ? {} : { port })
}

/** Last `n` lines of `text`, ignoring a trailing newline. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(Math.max(0, lines.length - n))
}

export function logs(options: { lines: number }): void {
  let raw: string
  try {
    raw = fs.readFileSync(logPath(), 'utf8')
  } catch {
    console.log(`No log at ${logPath()} yet.`)
    return
  }
  for (const line of tailLines(raw, options.lines)) console.log(line)
}

export async function open(options: { port?: number }): Promise<void> {
  const port = options.port ?? readMeta()?.port ?? defaultPort()
  const url = `http://127.0.0.1:${port}/ui`
  if (!process.stdout.isTTY) {
    console.log(url)
    return
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
  child.on('error', () => console.log(url))
  child.unref()
  console.log(url)
}

/** Poll `check` until true or the budget runs out. Resolution beats a fixed sleep. */
async function waitFor(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return check()
}
