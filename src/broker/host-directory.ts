import { randomBytes, randomUUID } from 'node:crypto'
import type { ConnectedLauncher } from '../agents/teleport-destination.js'
import type { HostProbe, RemoteLaunch, SurfaceName } from '../protocol.js'
import { logEvent } from './log.js'

/**
 * CC-951: the host launchers connected to this broker, one per machine, so a teleport can
 * land a successor on a machine with no live predecessor to launch it. Presence-only, like
 * registration: an entry lives exactly as long as its connection, and nothing is persisted.
 *
 * A launcher self-reports its host, as `register` self-reports a session's. The trust
 * boundary is unchanged: the OS account plus whatever forward reaches the socket.
 */

/** What a launcher says about itself in `host_hello`. */
export interface LauncherHello {
  host: string
  platform: NodeJS.Platform
  /** The surfaces it can open on its own machine. */
  surfaces: SurfaceName[]
}

export interface LauncherEntry extends LauncherHello {
  connectedAt: number
}

/** The one shape every launcher answer has: done, or why not. */
export interface HostAnswer {
  ok: boolean
  reason?: string
  /** CC-1472: where a probe looked for the session it was asked to resume, and whether it was there. */
  transcript?: { path: string; found: boolean }
}

/** A frame the broker asks a launcher to act on; `id` pairs it with the answer. */
export type HostRequest =
  | { t: 'host_probe'; id: string; probe: HostProbe }
  | { t: 'host_launch'; id: string; launch: RemoteLaunch }
  | { t: 'host_spawn'; id: string; launch: RemoteLaunch }

export const PROBE_TIMEOUT_MS = 10_000
export const LAUNCH_TIMEOUT_MS = 60_000

interface Connected<K> {
  key: K
  entry: LauncherEntry
  send: (frame: HostRequest) => void
  /** CC-1331: kept off `LauncherEntry`, which goes over the wire in `hosts_result`. */
  proved: boolean
}

interface Outstanding<K> {
  key: K
  host: string
  settle: (answer: HostAnswer) => void
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export class HostDirectory<K = unknown> {
  private readonly byHost = new Map<string, Connected<K>>()
  private readonly outstanding = new Map<string, Outstanding<K>>()
  private readonly nonces = new Map<K, string>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The first live launcher for a machine holds it. A second connection claiming the same
   * machine is refused while the holder's connection is open, so it cannot take over the
   * probes and launches meant for the real one; a restarted launcher's old entry has already
   * gone with its connection. The holder may hello again, which replaces its own entry.
   * `proved` is the broker's own verdict on this hello's key proof (CC-1331).
   */
  hello(key: K, hello: LauncherHello, send: (frame: HostRequest) => void, proved: boolean): HostAnswer {
    const holder = this.find(hello.host)
    if (holder !== undefined && holder.key !== key)
      return { ok: false, reason: `a launcher for ${holder.entry.host} is already connected` }
    const current = this.hostOf(key)
    if (current !== undefined && !same(current, hello.host))
      return { ok: false, reason: `this connection is already the launcher for ${current}` }
    const entry = { ...hello, connectedAt: this.now() }
    this.byHost.set(hello.host.toLowerCase(), { key, entry, send, proved })
    logEvent('host_launcher_connected', { host: hello.host, platform: hello.platform })
    return { ok: true }
  }

  /**
   * CC-1063: a fresh nonce for this connection's next hello proof, replacing any earlier one.
   * It is bound to the connection, so a proof seen on one connection is useless on another.
   */
  challenge(key: K): string {
    const nonce = randomBytes(32).toString('hex')
    this.nonces.set(key, nonce)
    return nonce
  }

  /** The connection's nonce, at most once: a hello consumes it whether or not its proof holds. */
  takeNonce(key: K): string | undefined {
    const nonce = this.nonces.get(key)
    this.nonces.delete(key)
    return nonce
  }

  /** The machine this connection launches for, if it is a launcher. */
  hostOf(key: K): string | undefined {
    return [...this.byHost.values()].find(connected => connected.key === key)?.entry.host
  }

  /** The launcher's connection closed: its entry goes, and anything waiting on it is answered now. */
  drop(key: K): void {
    this.nonces.delete(key)
    for (const [host, connected] of this.byHost)
      if (connected.key === key) {
        this.byHost.delete(host)
        logEvent('host_launcher_dropped', { host: connected.entry.host })
      }
    for (const waiting of [...this.outstanding.values()])
      if (waiting.key === key)
        waiting.settle({ ok: false, reason: `launcher on ${waiting.host} disconnected` })
  }

  list(): LauncherEntry[] {
    return [...this.byHost.values()].map(connected => connected.entry)
  }

  launchers(): ConnectedLauncher[] {
    return [...this.byHost.values()].map(({ entry: { host, platform }, proved }) => ({
      host,
      platform,
      proved,
    }))
  }

  surfacesOn(host: string): readonly SurfaceName[] {
    return this.find(host)?.entry.surfaces ?? []
  }

  find(host: string): Connected<K> | undefined {
    return [...this.byHost.values()].find(connected => same(connected.entry.host, host))
  }

  probe(host: string, probe: HostProbe, timeoutMs = PROBE_TIMEOUT_MS): Promise<HostAnswer> {
    return this.ask(host, id => ({ t: 'host_probe', id, probe }), timeoutMs)
  }

  launch(host: string, launch: RemoteLaunch, timeoutMs = LAUNCH_TIMEOUT_MS): Promise<HostAnswer> {
    return this.ask(host, id => ({ t: 'host_launch', id, launch }), timeoutMs)
  }

  /** CC-1472: run `launch` through the launcher's spawn executor (CC-1062); a host resume uses it. */
  spawn(host: string, launch: RemoteLaunch, timeoutMs = LAUNCH_TIMEOUT_MS): Promise<HostAnswer> {
    return this.ask(host, id => ({ t: 'host_spawn', id, launch }), timeoutMs)
  }

  /** Only the connection that was asked may answer, so another one cannot settle its request. */
  answer(key: K, id: string, answer: HostAnswer): boolean {
    const waiting = this.outstanding.get(id)
    if (waiting === undefined || waiting.key !== key) return false
    waiting.settle(answer)
    return true
  }

  private ask(host: string, frame: (id: string) => HostRequest, timeoutMs: number): Promise<HostAnswer> {
    const connected = this.find(host)
    if (connected === undefined)
      return Promise.resolve({ ok: false, reason: `no launcher connected on ${host}` })
    const id = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(
        () => settle({ ok: false, reason: `launcher on ${host} did not answer within ${timeoutMs / 1000}s` }),
        timeoutMs,
      )
      timer.unref?.()
      const settle = (answer: HostAnswer): void => {
        clearTimeout(timer)
        this.outstanding.delete(id)
        resolve(answer)
      }
      this.outstanding.set(id, { key: connected.key, host: connected.entry.host, settle })
      connected.send(frame(id))
    })
  }
}
