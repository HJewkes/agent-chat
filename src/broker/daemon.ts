import fs from 'node:fs'
import net from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { defaultPort, home, socketPath } from '../paths.js'
import { BrokerCore } from './core.js'
import { buildHttpApp } from './http.js'
import {
  probeSocket,
  readPidFile,
  removeStateFiles,
  watchSocket,
  writeMeta,
  writePidFile,
} from './lifecycle.js'
import { logEvent } from './log.js'
import { deliver, SocketServer } from './socket.js'
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

/**
 * Returns the socket server, or null when another broker already holds the path.
 *
 * The return type is the socket server rather than a handle over both listeners
 * because that is what `is another broker already running` means here, and
 * because `agent-chat broker` is a process-launch contract whose shape should
 * not shift under a caller that only wants to know whether it won the race.
 */
export async function startBroker(options: StartBrokerOptions = {}): Promise<net.Server | null> {
  const sock = socketPath()
  fs.mkdirSync(home(), { recursive: true })
  if (!(await claimSocketPath(sock))) return null

  const core = new BrokerCore(deliver)
  const socketServer = new SocketServer(core)
  const server = await listenOn(sock, socketServer)

  // Only after the socket is serving, and only ever best-effort.
  const http = options.http === false ? null : await bindHttp(core, options.port ?? defaultPort())
  recordBrokerState(http?.port ?? null)

  // The watcher and the shutdown it triggers are mutually referential: shutdown
  // must stop the watcher, and the watcher must be able to call shutdown. The
  // indirection below keeps that cycle, which the original expressed by closing
  // over a `const` declared further down — shutdown never runs before startup
  // finishes, so the reference is always resolved by the time it is read.
  let stopWatching: (() => void) | undefined
  const shutdown = makeShutdown({
    sock,
    server,
    socketServer,
    core,
    http: http?.server ?? null,
    stopWatching: () => stopWatching?.(),
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

  installSignalHandlers(shutdown)
  return server
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

/** Bind the listener and hand connections to `socketServer`. */
async function listenOn(sock: string, socketServer: SocketServer): Promise<net.Server> {
  const server = net.createServer(conn => socketServer.onConnection(conn))
  server.on('error', err => logEvent('broker_error', { error: String(err) }))

  await new Promise<void>(resolve => server.listen(sock, resolve))
  fs.chmodSync(sock, 0o600) // this user only; the trust boundary is the OS account
  logEvent('broker_started', { pid: process.pid, sock })
  return server
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
 * Exported so the tolerance can be tested against a genuinely occupied port
 * without standing up a whole broker.
 */
export async function bindHttp(
  core: BrokerCore,
  port: number,
): Promise<{ server: ServerType; port: number } | null> {
  let bound: number | null = null
  const app = buildHttpApp({ core, port: () => bound })

  return new Promise(resolve => {
    let settled = false
    const finish = (result: { server: ServerType; port: number } | null): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let server: ServerType
    try {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, info => {
        bound = info.port
        logEvent('http_started', { port: info.port })
        finish({ server, port: info.port })
      })
    } catch (err) {
      logEvent('http_unavailable', { port, error: String(err) })
      return finish(null)
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      logEvent('http_unavailable', { port, error: err.code ?? String(err) })
      finish(null)
    })
  })
}

/**
 * Written only after the socket is bound and serving, so their presence never
 * implies more than is true. `port` is what the listener actually got, or null:
 * recording an intended port as though it were a bound one is how a status
 * command starts lying.
 */
function recordBrokerState(port: number | null): void {
  writePidFile()
  writeMeta({ port, version: VERSION, started: Date.now(), pid: process.pid })
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
