import fs from 'node:fs'
import net from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import type { Hono } from 'hono'
import { burndownConfigPath, burndownLedgerPath, defaultPort, home, socketPath } from '../paths.js'
import { activeWorkRoot } from '../agents/active-work.js'
import {
  resolveOrphanReapKill,
  resolveAgentSlots,
  resolveMachineLimits,
  resolvePoolPickMode,
  resolveSeatSpawnMode,
  resolveProcessGuardMode,
  resolveProcessKillBytes,
  resolveAutoRetireOnReport,
} from '../config.js'
import { readMemoryFree } from '../agents/machine-guard.js'
import { Semaphore } from '../agents/semaphore.js'
import { backfillAtBoot } from '../agents/ledger/backfill-run.js'
import { shadowLedgerFromConfig } from '../agents/ledger/shadow-ledger.js'
import { defaultAutonomyRoot, isWatchedSeat } from '../agents/seats/io.js'
import { seatJournal } from '../agents/seats/journal.js'
import { cliShepherdSkipPort } from '../agents/isolation/shepherd-skip.js'
import { seatDispatchLog } from '../agents/seats/dispatch-log.js'
import {
  readHandReserve,
  readOverlap,
  readSeatSpawn,
  type OverlapRequest,
  type SeatSpawnRequest,
} from '../agents/seats/spawn-gate-read.js'
import { readPoolPick, type PoolPickRequest } from '../agents/seats/pool-route.js'
import { BrokerCore } from './core.js'
import { EventLog } from './event-log.js'
import { activeHold } from './hold.js'
import { buildHttpApp, type HttpAppOptions } from './http.js'
import { isEphemeralHome, watchIdle } from './ephemeral.js'
import { newestBuildMtime } from './staleness.js'
import {
  probeSocket,
  readPidFile,
  removeStateFiles,
  watchSocket,
  writeMeta,
  writePidFile,
} from './lifecycle.js'
import { hostLeaseRefusal } from '../host-lease.js'
import { logEvent } from './log.js'
import { installedCliPaths, lsofCwd, readPsTable, startReaper } from './reaper.js'
import { clearLaunchIdentity } from '../launch-identity.js'
import { startAgeOutSweep } from './age-out.js'
import { startOrphanSweep } from '../agents/orphan-sweep.js'
import { startProcessGuard } from '../agents/process-guard-monitor.js'
import { deliver, SocketServer } from './socket.js'
import { ensureToken } from './token.js'
import { VERSION } from './version.js'

/**
 * Bringing the broker up, in the one order that is safe.
 *
 * SOCKET FIRST, ALWAYS. The socket probe is the single-instance guard, and it is
 * better than a PID file because it proves a process is accepting connections
 * rather than that something once wrote a number. It has to run before anything
 * else is touched, or two racing auto-starts can both reach `listen(7600)`.
 *
 * THE PORT IS AN ACCESSORY. In the reference implementation the daemon IS the
 * port; here the socket is the service and the port hosts a dashboard. So a
 * refused bind is logged and swallowed — messaging must never fail because
 * something else is on 7600.
 */

export interface StartBrokerOptions {
  /** Overrides `AGENT_CHAT_PORT`, which overrides 7600. */
  port?: number
  /** Skip the HTTP bind entirely. For tests that only want the socket. */
  http?: boolean
}

/** The cap is passed as the resolver, not its value, so `agentSlots` is re-read on every spawn (CC-159). */
export function newAgentSlots(): Semaphore {
  return new Semaphore(resolveAgentSlots)
}

/**
 * Returns the socket server, or null when another broker already holds the path.
 *
 * The return type is the socket server rather than a handle over both listeners
 * because that is what `is another broker already running` means here, and
 * because `agent-chat broker` is a process-launch contract whose shape should
 * not shift under a caller that only wants to know whether it won the race.
 */
export async function startBroker(options: StartBrokerOptions = {}): Promise<net.Server | null> {
  // A broker started by hand from inside an agent still must not hand that launch's identity or temp dir to its children.
  clearLaunchIdentity(process.env)
  const sock = socketPath()
  fs.mkdirSync(home(), { recursive: true })
  if (isHeld() || isOffLease() || !(await claimSocketPath(sock))) return null
  const listener = await listenOn(sock)
  if (listener === null) return null

  const { core, socketServer } = openServices()
  listener.serve(socketServer)
  socketServer.startLifecycleVerifier()
  const stopReaper = startBrokerReaper()
  const stopAgeOut = startAgeOutSweep(core)
  const stopOrphanSweep = startOrphanSweep(
    () => core.agents.roster({ includeRetired: true }),
    logEvent,
    resolveOrphanReapKill,
  )
  const stopProcessGuard = isEphemeralHome(home()) ? () => undefined : startBrokerProcessGuard()
  const { server, openConnections } = listener

  // Only after the socket is serving, and only ever best-effort.
  const lifecycle = socketServer.lifecycle()
  const http =
    options.http === false
      ? null
      : await bindHttp(core, options.port ?? defaultPort(), ensureToken(), undefined, undefined, {
          slots: () => socketServer.slotUsage(),
          ...(lifecycle === undefined ? {} : { lifecycle }),
        })
  recordBrokerState(http?.port ?? null)

  // The watcher and the shutdown it triggers are mutually referential: shutdown
  // must stop the watcher, and the watcher must be able to call shutdown. The
  // indirection below keeps that cycle, which the original expressed by closing
  // over a `const` declared further down — shutdown never runs before startup
  // finishes, so the reference is always resolved by the time it is read.
  let stopWatching: (() => void) | undefined
  let stopIdleWatch: (() => void) | undefined
  const shutdown = makeShutdown({
    sock,
    server,
    socketServer,
    core,
    http: http?.server ?? null,
    stopWatching: () => {
      stopWatching?.()
      stopIdleWatch?.()
      stopReaper()
      stopAgeOut()
      stopOrphanSweep()
      stopProcessGuard()
    },
  })

  // A broker whose socket has been unlinked is unreachable, not degraded: no
  // client can find it and nothing will ever end it. See `watchSocket`.
  stopWatching = watchSocket({
    path: sock,
    owner: readPidFile,
    onLost: reason => {
      logEvent('broker_exit', { reason, pid: process.pid })
      shutdown(!fs.existsSync(sock))
    },
  })

  // A broker under a throwaway home belongs to one run of something and has no
  // reason to outlive it. The shared bus is deliberately exempt — it sits at
  // zero connections for days by design, so idleness alone must never end it.
  // See `ephemeral.ts` for why the gate is the home's location (CC-76).
  if (isEphemeralHome(home())) {
    stopIdleWatch = watchIdle({
      connections: openConnections,
      onIdle: idleForMs => {
        logEvent('broker_exit', { reason: 'ephemeral home idle', idleForMs, pid: process.pid })
        shutdown(true)
      },
    })
  }

  installSignalHandlers(shutdown)
  return server
}

const REAP_MIN_AGE_MS = 120_000

function startBrokerReaper(): () => void {
  const excludePaths = installedCliPaths()
  return startReaper({
    readTable: () => readPsTable(),
    kill: pid => process.kill(pid, 'SIGTERM'),
    cwdOf: lsofCwd,
    log: entry => logEvent('reaped', entry),
    options: () => ({
      uid: process.getuid?.() ?? -1,
      now: Date.now(),
      minAgeMs: REAP_MIN_AGE_MS,
      selfPid: process.pid,
      excludePaths,
    }),
  })
}

/** A ps slower than this fails the tick rather than stacking behind the 2 s interval. */
const PROCESS_GUARD_PS_TIMEOUT_MS = 1000

/** CC-495: never under an ephemeral home, so a test broker cannot signal the machine's processes. */
function startBrokerProcessGuard(): () => void {
  return startProcessGuard({
    readTable: () => readPsTable(Date.now(), PROCESS_GUARD_PS_TIMEOUT_MS),
    kill: pid => process.kill(pid, 'SIGKILL'),
    log: logEvent,
    mode: resolveProcessGuardMode,
    limitBytes: resolveProcessKillBytes,
    now: Date.now,
    brokerPid: process.pid,
    uid: process.getuid?.() ?? -1,
  })
}

/**
 * Take ownership of the socket path, or report that someone else already has it.
 *
 * Probes the socket BEFORE touching any other resource. This is the single
 * instance guard, and it has to run first so two racing auto-starts can never
 * both get as far as binding a port.
 */
async function claimSocketPath(sock: string): Promise<boolean> {
  if (await probeSocket(sock)) {
    logEvent('broker_exit', { reason: 'another broker is already listening' })
    return false
  }
  if (fs.existsSync(sock)) fs.unlinkSync(sock)
  return true
}

/** `service stop --hold` (CC-153): refuse to start until the hold expires, so an offline job can run. */
function isHeld(): boolean {
  const until = activeHold()
  if (until === undefined) return false
  logEvent('broker_exit', { reason: 'held by service stop --hold', until: new Date(until).toISOString() })
  return true
}

/** CC-806: the factory host lease names another machine, so this broker must not bind. */
function isOffLease(): boolean {
  const message = hostLeaseRefusal()
  if (message === undefined) return false
  logEvent('broker_exit', { reason: message })
  return true
}

/**
 * Everything that reads or writes `events.db`, opened only by the broker that won
 * the listen. Siblings that raced it through the probe exit having touched nothing,
 * which is what keeps the boot backfill to one writer (CC-153).
 * `ephemeral` is a parameter so a test can open the services of a lasting home over temp roots.
 */
export function openServices(ephemeral = isEphemeralHome(home())): {
  core: BrokerCore
  socketServer: SocketServer
} {
  const events = new EventLog()
  // A per-run home is a test's: it must not hold messages by this machine's real charter.
  const core = new BrokerCore(deliver, { events, ...(ephemeral ? {} : { isSeat: isWatchedSeat }) })
  const ledger = shadowLedgerFromConfig(() => events.ledgerHandle())
  if (ledger) backfillAtBoot(events, ledger.fence)
  // CC-316, CC-331, CC-288, CC-606: the same rule for the seat journal, dispatch log, spawn budget gate and pool pick, which read the real autonomy root.
  const journal = ephemeral
    ? {}
    : {
        seatJournal: seatJournal(defaultAutonomyRoot()),
        seatDispatch: seatDispatchLog(defaultAutonomyRoot()),
        shepherdSkip: cliShepherdSkipPort,
        autoRetireOnReport: resolveAutoRetireOnReport,
        seatBudget: { read: (spawn: SeatSpawnRequest) => readSeatSpawn(defaultAutonomyRoot(), spawn) },
        seatOverlap: {
          mode: resolveSeatSpawnMode,
          read: (spawn: OverlapRequest) =>
            readOverlap(
              { root: defaultAutonomyRoot(), ledgerFile: burndownLedgerPath(), activeRoot: activeWorkRoot() },
              spawn,
            ),
          handReserve: (spawn: OverlapRequest) =>
            readHandReserve(
              {
                root: defaultAutonomyRoot(),
                ledgerFile: burndownLedgerPath(),
                activeRoot: activeWorkRoot(),
                tickConfigFile: burndownConfigPath(),
              },
              spawn,
            ),
        },
        poolPick: {
          read: (spawn: PoolPickRequest) => readPoolPick(defaultAutonomyRoot(), spawn),
          mode: resolvePoolPickMode,
        },
      }
  const socketServer = new SocketServer(
    core,
    {
      semaphore: newAgentSlots(),
      machineGuard: { readMemoryFree: () => readMemoryFree(), limits: resolveMachineLimits },
      ...(ledger === undefined ? {} : { ledger }),
      ...journal,
    },
    ledger === undefined ? undefined : events.ledgerHandle(),
  )
  return { core, socketServer }
}

interface Listener {
  server: net.Server
  openConnections: () => number
  /** Hands connections to `socketServer`, including any accepted before it existed. */
  serve: (socketServer: SocketServer) => void
}

/**
 * Bind the listener, or return null when a sibling broker bound the path first.
 *
 * Counts open connections as it goes. `server.getConnections` would answer the
 * same question, but only through a callback, which would make the idle reaper's
 * timer async for no gain — and a counter is something a test can state outright.
 */
async function listenOn(sock: string): Promise<Listener | null> {
  let open = 0
  let handle: ((conn: net.Socket) => void) | undefined
  const early: net.Socket[] = []
  const server = net.createServer(conn => {
    open++
    // `close` rather than `end`: a half-open connection is still a client, and
    // counting it as gone would let the reaper fire with someone still attached.
    conn.on('close', () => {
      open--
    })
    if (handle) handle(conn)
    else early.push(conn)
  })

  if (!(await bind(server, sock))) return null
  server.on('error', err => logEvent('broker_error', { error: String(err) }))
  fs.chmodSync(sock, 0o600) // this user only; the trust boundary is the OS account
  logEvent('broker_started', { pid: process.pid, sock })
  const serve = (socketServer: SocketServer): void => {
    handle = conn => socketServer.onConnection(conn)
    for (const conn of early.splice(0)) handle(conn)
  }
  return { server, openConnections: () => open, serve }
}

/** Both codes mean the path is taken; which one a lost bind gets depends on the race. */
const PATH_TAKEN = new Set(['EADDRINUSE', 'EEXIST'])

/** False when a sibling that passed the socket probe alongside us listened first. */
function bind(server: net.Server, sock: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (!PATH_TAKEN.has(err.code ?? '')) return reject(err)
      logEvent('broker_exit', { reason: 'another broker is already listening' })
      resolve(false)
    }
    server.once('error', onError)
    server.listen(sock, () => {
      server.off('error', onError)
      resolve(true)
    })
  })
}

/**
 * Bind the dashboard port, or return null and carry on.
 *
 * `EADDRINUSE` is not an error condition here, it is an expected one — a second
 * broker cannot exist (the socket guard saw to that), so the holder is some
 * other program, and the right response is to serve the socket and log why the
 * dashboard is unreachable. `127.0.0.1` only, never `0.0.0.0`.
 *
 * The port reaches the app through a getter because it is not known until the
 * listener is up, and `/health` must report the port actually bound rather than
 * the one we asked for.
 *
 * `token` defaults to null so a test can bind a bare port without minting a
 * secret; `startBroker` always passes one. The dashboard gets its copy injected
 * into the HTML the broker itself serves, so both sides read the same 0600 file
 * and nothing has to be configured.
 *
 * Exported so the tolerance can be tested against a genuinely occupied port
 * without standing up a whole broker.
 *
 * `EADDRINUSE` right after boot is often another process still tearing its own
 * listener down (a broker restart racing the OS releasing the old socket), not
 * a permanent occupant. A couple of short retries absorbs that race; giving up
 * after one attempt was CC-70 — the log showed a single `http_unavailable` and
 * nothing ever tried again, so a transient collision looked identical to a
 * permanently occupied port.
 */
const BIND_RETRY_ATTEMPTS = 3
const BIND_RETRY_DELAY_MS = 150

export async function bindHttp(
  core: BrokerCore,
  port: number,
  token: string | null = null,
  attempts: number = BIND_RETRY_ATTEMPTS,
  retryDelayMs: number = BIND_RETRY_DELAY_MS,
  readings: Pick<HttpAppOptions, 'slots' | 'lifecycle'> = {},
): Promise<{ server: ServerType; port: number } | null> {
  let bound: number | null = null
  const app = buildHttpApp({ core, port: () => bound, token, dashboard: { token: () => token }, ...readings })

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await tryBindOnce(app, port, attempt, attempts)
    if (result !== null) {
      bound = result.port
      return result
    }
    if (attempt < attempts) await sleep(retryDelayMs)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function tryBindOnce(
  app: Hono,
  port: number,
  attempt: number,
  attempts: number,
): Promise<{ server: ServerType; port: number } | null> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: { server: ServerType; port: number } | null): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const giveUp = (error: string): void => {
      const willRetry = attempt < attempts
      logEvent('http_unavailable', { port, error, attempt, attempts, willRetry })
      finish(null)
    }

    let server: ServerType
    try {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, info => {
        logEvent('http_started', { port: info.port, attempt })
        finish({ server, port: info.port })
      })
    } catch (err) {
      giveUp(String(err))
      return
    }

    server.on('error', (err: NodeJS.ErrnoException) => giveUp(err.code ?? String(err)))
  })
}

/**
 * Written only after the socket is bound and serving, so their presence never
 * implies more than is true. `port` is what the listener actually got, or null:
 * recording an intended port as though it were a bound one is how a status
 * command starts lying.
 */
/**
 * Sampled at import, before anything binds (CC-57).
 *
 * This is a statement about the code THIS PROCESS LOADED, so the earliest
 * possible read is the most accurate one — a sample taken later could pick up a
 * build that landed during startup and record it as though we were running it.
 * Doing the walk here also keeps it out of the window between binding the socket
 * and writing the pid file, which a test races.
 */
const BUILD_AT_LOAD = newestBuildMtime()

function recordBrokerState(port: number | null): void {
  writePidFile()
  writeMeta({
    port,
    version: VERSION,
    started: Date.now(),
    pid: process.pid,
    ...(BUILD_AT_LOAD === null ? {} : { buildMtime: BUILD_AT_LOAD.mtimeMs }),
  })
}

interface ShutdownDeps {
  sock: string
  server: net.Server
  socketServer: SocketServer
  core: BrokerCore
  http: ServerType | null
  stopWatching: () => void
}

/**
 * `tidy` is false for exactly one caller: the watchdog, when the socket at our
 * path now belongs to a DIFFERENT broker. Unlinking then would take out a live
 * broker's socket on the way out, and removing the state files would delete
 * the pid and meta it had just written — turning our own orphaning into an
 * outage for whoever replaced us.
 */
function makeShutdown({ sock, server, socketServer, core, http, stopWatching }: ShutdownDeps) {
  return (tidy = true): void => {
    logEvent('broker_stopping', { pid: process.pid })
    stopWatching()
    server.close()
    http?.close()
    socketServer.close()
    core.close()
    if (tidy) {
      if (fs.existsSync(sock)) fs.unlinkSync(sock)
      removeStateFiles()
    }
    process.exit(0)
  }
}

function installSignalHandlers(shutdown: () => void): void {
  process.on('SIGINT', () => shutdown())
  process.on('SIGTERM', () => shutdown())
}
