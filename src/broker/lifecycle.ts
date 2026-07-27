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
