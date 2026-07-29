import fs from 'node:fs'
import net from 'node:net'
import { home, metaPath, pidPath, socketPath } from '../paths.js'

/**
 * State files and liveness probes.
 *
 * The important asymmetry, and it is easy to get backwards: **the socket is
 * authoritative for "is it running", the PID file is diagnostic only.** A socket
 * probe proves a process is accepting connections; a PID file only proves
 * something once wrote a number, and it survives `kill -9`. Everything here is
 * ordered around that — nothing answers liveness from `broker.pid`.
 */

export interface BrokerMeta {
  port: number | null
  version: string
  started: number
  pid: number
}

/** Connect to the socket: an answer is proof of a live broker, not just a leftover file. */
export function probeSocket(sock: string = socketPath()): Promise<boolean> {
  return new Promise(resolve => {
    if (!fs.existsSync(sock)) return resolve(false)
    const probe = net.connect(sock)
    probe.on('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
  })
}

/**
 * Signal 0 checks for the process without touching it. EPERM means it exists and
 * belongs to someone else, which is still "alive" for our purposes.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function writePidFile(pid: number = process.pid): void {
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(pidPath(), `${pid}\n`, { mode: 0o600 })
}

export function readPidFile(): number | null {
  try {
    const parsed = Number.parseInt(fs.readFileSync(pidPath(), 'utf8').trim(), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

export function writeMeta(meta: BrokerMeta): void {
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(metaPath(), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Returns null for missing, unreadable or malformed meta. A half-written file
 * after a hard kill must not crash `service status` — the socket probe is what
 * actually answers the question, so this is allowed to give up quietly.
 */
export function readMeta(): BrokerMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(), 'utf8')) as Partial<BrokerMeta>
    if (typeof parsed.version !== 'string' || typeof parsed.started !== 'number') return null
    if (typeof parsed.pid !== 'number') return null
    const port = typeof parsed.port === 'number' ? parsed.port : null
    return { port, version: parsed.version, started: parsed.started, pid: parsed.pid }
  } catch {
    return null
  }
}

/**
 * How often a broker checks that the socket it bound is still its own.
 *
 * Long, because it is a leak reaper rather than a health check: nothing depends
 * on noticing quickly, and a broker polling its own socket every second would be
 * spending a wakeup a second forever to catch an event that happens once.
 */
export const SOCKET_WATCH_MS = 30_000

export interface SocketWatch {
  /** The path bound at startup. */
  path: string
  /**
   * Who owns the socket now — `readPidFile` in production, injected so this is
   * testable without a broker. Null means unknown, which is deliberately NOT
   * read as "someone else": a missing or half-written pid file is a routine
   * state, and exiting on it would make a diagnostic file load-bearing.
   */
  owner: () => number | null
  ownPid?: number
  intervalMs?: number
  /** Called once, with a reason to log, when the socket is no longer ours. */
  onLost: (reason: string) => void
}

/**
 * Exit when the socket a broker bound is no longer its own.
 *
 * The socket IS the lease — everything else here is ordered around that — and a
 * broker whose socket has been unlinked is not degraded, it is UNREACHABLE. No
 * client can find it, it will never serve another request, and nothing will ever
 * come along to end it. Seven such processes were found running against deleted
 * temp directories, the oldest a day old, each holding a sqlite handle to a
 * database that no longer existed.
 *
 * The cause is structural rather than careless: `BrokerClient` auto-starts a
 * broker `detached` and `unref`ed, precisely so it outlives whichever session
 * happened to need it first. Any test that points `AGENT_CHAT_HOME` at a temp
 * directory therefore causes a broker, and cleaning that directory up does not
 * end it. `reapBroker` exists for this and is easy to forget — which is why the
 * fix belongs in the broker, where forgetting is not an option, rather than in
 * one more thing every test has to remember.
 *
 * Returns its own cancel, and the timer is unref'd so it never holds the process
 * open on its own.
 */
export function watchSocket({
  path,
  owner,
  ownPid = process.pid,
  intervalMs = SOCKET_WATCH_MS,
  onLost,
}: SocketWatch): () => void {
  const timer = setInterval(() => {
    if (!fs.existsSync(path)) {
      clearInterval(timer)
      return onLost(`the socket at ${path} is gone; nothing can reach this broker`)
    }
    // Ownership is asked of the pid file rather than inferred from the socket's
    // inode, which is what this first tried. Inode numbers are REUSED: on the
    // Linux runner, deleting a socket and binding a new one at the same path
    // handed back the same inode, so "is it still mine" answered yes about a
    // file that was not. A pid cannot be wrong in that direction.
    //
    // Note this is not the pid file answering LIVENESS — the socket does that,
    // and that asymmetry still holds. It is answering identity: who owns the
    // path now. A broker that finds someone else's pid there must leave both
    // the socket and the state files alone on its way out.
    const who = owner()
    if (who !== null && who !== ownPid) {
      clearInterval(timer)
      onLost(`the socket at ${path} belongs to broker ${who} now`)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Both state files go together; neither is load-bearing, so failure to remove is not fatal. */
export function removeStateFiles(): void {
  for (const file of [pidPath(), metaPath()]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // A leftover file is harmless: the socket probe is what answers liveness.
    }
  }
}
