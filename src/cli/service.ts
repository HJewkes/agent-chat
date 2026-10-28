import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { HealthPayload } from '../api-contract.js'
import { installCrashLog } from '../broker/crash-log.js'
import { probeHealth } from '../broker/doctor.js'
import { activeHold, clearHold, writeHold } from '../broker/hold.js'
import { exitWithWatchedPid } from '../broker/parent-watch.js'
import { isProcessAlive, probeSocket, readMeta, readPidFile, removeStateFiles } from '../broker/lifecycle.js'
import { clearInheritedShimEnv, recordLoginPath, resolveBasePath } from '../agents/base-path.js'
import { cliEntry, defaultPort, home, logPath, socketPath } from '../paths.js'
import { type ServerMessage } from '../protocol.js'
import { RESTART_GAP_ENV, RESTART_TOKEN_ENV, withoutLaunchIdentity } from '../launch-identity.js'
import { isEphemeralHome } from '../broker/ephemeral.js'
import { MAX_RESTART_LOCK_S, releaseRestartLock, takeRestartLock } from '../broker/restart-lock.js'
import { fail, withBroker } from './client.js'
import { brokerSource, guardRestart, unreachableMessage } from './restart-guard.js'

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
    // No auto-start: a stop must never start a broker, and under a restart lock it would wait out the lock.
    const res = (await withBroker(b => b.request({ t: 'list' }, 'list_result'), {
      autoStart: false,
    })) as Extract<ServerMessage, { t: 'list_result' }>
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
    // Every auto-start lands here, so the broker's own children get a full PATH (CC-456), and
    // none of the push guard of an agent session that started it (CC-1653).
    clearInheritedShimEnv(process.env)
    process.env.PATH = resolveBasePath({ env: process.env, stateDir: home() })
    exitWithWatchedPid(process.env)
    installCrashLog()
    const { startBroker } = await import('../broker/index.js')
    const server = await startBroker()
    if (!server) console.error(refusedStart())
    return
  }

  const launched = await launchDetached(port)
  if (!launched.up) fail(notAnswering())
  printUp()
}

/** `token` is a restart's lock token: the one credential a broker may bind with while the lock is held. */
async function launchDetached(
  port: number | undefined,
  token?: string,
): Promise<{ pid: number | undefined; up: boolean }> {
  // Only the detached start lifts a hold: `agent-chat broker`, which every auto-start runs, is the foreground path.
  clearHold()
  recordLoginPath(home(), process.env.PATH)

  // Detached, matching `spawnBroker` (`broker-client.ts:90`) — the broker must
  // outlive whichever process happened to want it first.
  const env = withoutLaunchIdentity(
    port === undefined ? process.env : { ...process.env, AGENT_CHAT_PORT: String(port) },
  )
  if (token !== undefined) env[RESTART_TOKEN_ENV] = token
  const child = spawn(process.execPath, [cliEntry(), 'broker'], { detached: true, stdio: 'ignore', env })
  child.unref()
  return { pid: child.pid, up: await waitFor(() => probeSocket(), TERM_GRACE_MS) }
}

const notAnswering = (): string =>
  `Started, but nothing is answering on ${socketPath()} yet. Check: agent-chat service logs`

function printUp(): void {
  const meta = readMeta()
  console.log(`Broker up on ${socketPath()}${meta?.port ? ` and port ${meta.port}` : ''}.`)
}

function refusedStart(): string {
  const until = activeHold()
  if (until === undefined) return `a broker is already listening on ${socketPath()}`
  return `held until ${new Date(until).toISOString()}; \`agent-chat service start\` lifts it`
}

/** Refuse before signalling, and only ask a broker that is already up: connecting would start one. */
async function refuseIfBusy(verb: string, force: boolean | undefined): Promise<void> {
  if (force || !(await probeSocket())) return
  const refusal = await withBroker(b => guardRestart(verb, brokerSource(b))).catch((err: unknown) =>
    unreachableMessage(verb, err instanceof Error ? err.message : String(err)),
  )
  if (refusal !== null) fail(refusal)
}

export async function stop(options: { force?: boolean; hold?: number } = {}): Promise<void> {
  await refuseIfBusy('stop', options.force)
  // Written before the SIGTERM, so the auto-restarts it provokes already see it.
  const heldUntil = options.hold === undefined ? undefined : writeHold(options.hold)
  await stopBroker(heldUntil !== undefined)
  if (heldUntil !== undefined) {
    console.log(
      `Held until ${new Date(heldUntil).toISOString()}: brokers refuse to start until then. ` +
        '`agent-chat service start` lifts it early.',
    )
  }
}

async function stopBroker(held = false): Promise<void> {
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
  if (!held && attached !== null && attached > 0) {
    console.log(
      `${attached} session${attached === 1 ? ' was' : 's were'} attached — ` +
        'each will auto-restart the broker on its next message. `stop` is not sticky.',
    )
  }
}

/**
 * TP-4347: the lock is taken here rather than in restart-window.sh, so manual and rollback
 * restarts are covered too. Released on every return; a crash leaves a lock whose holder
 * pid is dead, which counts as none.
 */
export async function restart(options: { port?: number; force?: boolean }): Promise<void> {
  await refuseIfBusy('restart', options.force)
  const lock = takeRestartLock(MAX_RESTART_LOCK_S)
  if ('holder' in lock) {
    const { pid, until } = lock.holder
    fail(`restart: another restart holds the lock (pid ${pid}, until ${new Date(until).toISOString()})`)
  }
  let failure: string | undefined
  try {
    failure = await restartUnderLock(options, lock.token)
  } finally {
    releaseRestartLock(lock.token)
  }
  if (failure !== undefined) fail(failure)
}

/** Returns why the restart failed, or undefined once the broker this restart launched owns the socket. */
async function restartUnderLock(options: { port?: number }, token: string): Promise<string | undefined> {
  const previous = readMeta()?.port ?? undefined
  await stopBroker()
  // §4.5: the registry is in-memory, so process lifetime IS the registration
  // lease. Everything durable survives; presence does not, briefly.
  console.log('Registrations are in-memory: every session shows as reconnecting for a few seconds.')
  await testRestartGap()
  if (await probeSocket()) return notOurBroker(readPidFile(), undefined)
  const launched = await launchDetached(options.port ?? previous, token)
  if (!launched.up) return notAnswering()
  // The pid file is written just after the bind, so the socket can answer before it names its owner.
  if (!(await waitFor(async () => readPidFile() === launched.pid, TERM_GRACE_MS))) {
    return notOurBroker(readPidFile(), launched.pid)
  }
  printUp()
  return undefined
}

const notOurBroker = (onSocket: number | null, ours: number | undefined): string =>
  `restart: the broker on the socket (pid ${onSocket ?? 'unknown'}) is not the one this restart ` +
  `started (pid ${ours ?? 'none: another broker was already up'})`

/** Test seam: widens the gap a racing session reconnect lands in. Honoured only under an ephemeral home. */
async function testRestartGap(): Promise<void> {
  const ms = Number(process.env[RESTART_GAP_ENV])
  if (!isEphemeralHome(home()) || !Number.isFinite(ms) || ms <= 0) return
  await new Promise(resolve => setTimeout(resolve, Math.min(ms, MAX_TEST_GAP_MS)))
}

const MAX_TEST_GAP_MS = 10_000

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
