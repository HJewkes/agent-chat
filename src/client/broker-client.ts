import net from 'node:net'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import {
  encode,
  lineReader,
  type ClientMessage,
  type DeliveredMessage,
  type PermissionBehavior,
  type SystemEvent,
  type ReplyType,
  type ServerMessage,
} from '../protocol.js'
import { cliEntry, home, socketPath } from '../paths.js'

const REQUEST_TIMEOUT_MS = 5000

/**
 * Replies the 5s default is simply wrong for, and why raising it is the right
 * answer rather than a papering-over (CC-95).
 *
 * `spawn_result` answers both `spawn` and `retire`, and each one does real work
 * before it can say anything: a worktree allocation shells out to git, a launch
 * talks to iTerm2 over AppleScript, a retire runs `worktree remove` and now a
 * spawn additionally waits up to `ATTACH_TIMEOUT_MS` for the agent to register.
 * Two calls already returned "broker did not answer spawn_result" for operations
 * that had SUCCEEDED, which is the worst possible failure: the caller believes
 * nothing happened and an agent is running anyway.
 *
 * The alternative — keep 5s and answer immediately with a handle to poll — was
 * rejected because it hands every coordinator the same polling loop to write,
 * and a loop nobody writes is exactly how a spawn goes unnoticed for six hours.
 * A bounded wait that ends in a real answer beats an unbounded one that does not.
 *
 * 60s = the 30s attach window plus the launch work in front of it, with room for
 * a loaded machine. It is a ceiling, not a duration: the ordinary spawn answers
 * in a few seconds and nothing waits for this.
 */
const REPLY_TIMEOUT_MS: Partial<Record<ReplyType, number>> = { spawn_result: 60_000 }
// Front-loaded to catch a broker already starting, tailed off for a cold one; the sum is the give-up budget.
const RECONNECT_DELAYS_MS = [100, 250, 500, 1000, 2000, 5000]
const RETRY_WINDOW_S = Math.ceil(RECONNECT_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) / 1000)

/**
 * Frames safe to hold across a reconnect and send afterwards (CC-103).
 *
 * Each one states where the session should BE rather than asking for something to
 * happen, so sending it late, or after the reconnect's own registration, lands the
 * same state. `status` is the session's liveness and presence report, the nearest
 * thing this protocol has to a heartbeat. Nothing that delivers content is here:
 * a held `send` that the caller also retried would reach its recipient twice.
 */
const REPLAYABLE: ReadonlySet<ClientMessage['t']> = new Set([
  'register',
  'status',
  'subscribe',
  'unsubscribe',
])
// Bounded so a broker that never returns cannot grow this without limit.
const MAX_HELD_FRAMES = 32

const brokerRestartingError = (kind: ClientMessage['t']): Error =>
  new Error(
    `broker restarting: the connection to the agent-chat broker was lost and is being re-established. ` +
      `This ${kind} was NOT sent; retry it within ${RETRY_WINDOW_S} s.`,
  )

/**
 * For a request whose frame was already WRITTEN to the socket before the drop —
 * distinct from `brokerRestartingError`, which is for one that never left the
 * client. The broker may have received and even acted on this one; the only
 * thing lost is the reply, so "not sent" would be a claim this code cannot back up.
 */
const deliveryUnknownError = (): Error =>
  new Error(
    `broker restarting: the connection to the agent-chat broker was lost before its reply arrived. ` +
      `Delivery is unknown — it may already have been received and acted on. Check before retrying; ` +
      `the broker should be reachable again within ${RETRY_WINDOW_S} s.`,
  )

interface Waiter {
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

interface HeldFrame {
  message: ClientMessage
  replyType: ReplyType
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

/**
 * What gets replayed on reconnect. `agentId` is in here deliberately: a broker
 * restart that replayed only the name would reattach the process as an ordinary
 * session, and the durable agent would go quietly missing from the roster at
 * exactly the moment the roster is meant to be the trustworthy view.
 */
type Identity = Omit<Extract<ClientMessage, { t: 'register' }>, 't'>

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface BrokerClientOptions {
  /**
   * Spawn a detached broker when none is reachable. Defaults to true.
   *
   * A launchd-kept mirror must never resurrect a stopped broker (CC-153): the
   * stop is a deliberate state, not a crash, so a `KeepAlive` process reviving
   * it on the next connect attempt would make "stop" mean nothing.
   */
  autoStart?: boolean
}

/**
 * A session's connection to the broker. Reconnects on drop and replays its
 * registration, so a broker restart doesn't strand the session.
 */
export class BrokerClient {
  private socket: net.Socket | null = null
  private identity: Identity | null = null
  private closed = false
  /** The in-flight connect attempt, if any, so a second caller joins it instead of starting its own ladder. */
  private connecting: Promise<void> | null = null
  /** Guards against concurrent CC-83 recoveries racing for the same name. */
  private reregistering = false
  /** True between a drop and the reconnect's outcome: the gap frames are held or refused in. */
  private reconnecting = false
  private held: HeldFrame[] = []
  /** FIFO per reply type; the socket answers in order, so this stays aligned. */
  private readonly waiters = new Map<ReplyType, Waiter[]>()

  /**
   * `onFatal` fires when the broker says stop rather than retry. The only sender
   * today is a resume takeover, and the caller is expected to end the process:
   * this connection's identity now belongs to a successor, so reconnecting would
   * start a fight over it rather than recover from anything.
   */
  constructor(
    private readonly onDeliver: (message: DeliveredMessage) => void,
    private readonly onFatal?: (reason: string) => void,
    private readonly onSystemEvents?: (events: SystemEvent[]) => void,
    private readonly onPermissionVerdict?: (requestId: string, behavior: PermissionBehavior) => void,
    /** Fires once per lost connection, before any reconnect; for a caller whose state died with it (CC-144). */
    private readonly onDropped?: () => void,
    private readonly options: BrokerClientOptions = {},
  ) {}

  private handle(msg: ServerMessage): void {
    if (msg.t === 'deliver') return this.onDeliver(msg.message)
    if (msg.t === 'system_events') return this.onSystemEvents?.(msg.events)
    // A push with no waiter, like the two above: nothing on this side asked for
    // it, and the CLI leaves the callback unset so it can never be its target.
    if (msg.t === 'permission_verdict') return this.onPermissionVerdict?.(msg.requestId, msg.behavior)
    if (msg.t === 'error') {
      if (msg.code === 'not_registered') return void this.reregister()
      if (!msg.fatal) return
      // Set before destroying, so the close handler sees a deliberate shutdown
      // and does not climb the reconnect ladder.
      this.closed = true
      this.socket?.destroy()
      this.socket = null
      // The broker answered here, so unlike onDrop's failure this one is known.
      this.failAllWaiters(new Error(msg.reason))
      this.onFatal?.(msg.reason)
      return
    }
    const queue = this.waiters.get(msg.t)
    queue?.shift()?.resolve(msg)
  }

  private attach(socket: net.Socket): void {
    this.socket = socket
    socket.on(
      'data',
      lineReader<ServerMessage>(
        msg => this.handle(msg),
        () => undefined,
      ),
    )
    socket.on('close', () => void this.onDrop())
    socket.on('error', () => void this.onDrop())
  }

  /**
   * Replay the registration onto a connection the broker no longer knows (CC-83).
   *
   * `onDrop` covers the case where the socket closed and we saw it. This covers
   * the case where it did not: the broker dropped the registration, the socket
   * stayed up, and nothing on this side had any reason to suspect it. The identity
   * is already the thing `onDrop` replays, so recovery is the same act on a
   * different trigger.
   *
   * NO IDENTITY, NO ACTION — and that is what keeps the human's CLI out of this.
   * A CLI connection never registers, so it never has one to replay; it reaches
   * the broker over this same socket and would otherwise react to a hint meant for
   * sessions.
   *
   * Deliberately does NOT retry the frame that provoked the hint. That call fails
   * as it always has; what changes is that the session is addressable again by the
   * next one, rather than staying invisible until it restarts. Retrying would mean
   * buffering frames and re-driving the waiter queue, and a replayed `send` risks
   * delivering twice.
   */
  private async reregister(): Promise<void> {
    // One at a time: a burst of refused frames would otherwise each start their
    // own registration, and they would race each other for the same name.
    if (this.identity === null || this.reregistering || this.closed) return
    this.reregistering = true
    try {
      await this.request({ t: 'register', ...this.identity }, 'register_result')
    } catch {
      // The next refused frame hints again; a failed recovery must not be louder
      // than the condition it recovers from.
    } finally {
      this.reregistering = false
    }
  }

  private async onDrop(): Promise<void> {
    if (this.closed || this.socket === null) return
    this.socket = null
    this.failAllWaiters(deliveryUnknownError())
    this.onDropped?.()
    if (this.closed) return
    if (await this.reconnect()) await this.replayHeld()
  }

  private async reconnect(): Promise<boolean> {
    this.reconnecting = true
    try {
      await this.connect()
    } catch (err) {
      this.rejectHeld(err as Error)
      return false
    } finally {
      this.reconnecting = false
    }
    if (!this.closed) return true
    // Closed mid-ladder: the socket that just attached belongs to nobody.
    this.socket?.destroy()
    return false
  }

  /**
   * Registration first, so the held frames land on a connection the broker knows.
   * A held `register` is answered by that same registration rather than sent again:
   * `request` already made it the identity being replayed.
   */
  private async replayHeld(): Promise<void> {
    const registration = this.identity
      ? this.request({ t: 'register', ...this.identity }, 'register_result')
      : undefined
    const reply = await registration?.catch((err: Error) => err)
    for (const frame of this.held.splice(0)) {
      if (frame.message.t !== 'register')
        this.request(frame.message, frame.replyType).then(frame.resolve, frame.reject)
      else if (reply instanceof Error || reply === undefined)
        frame.reject(reply ?? new Error('no identity to register'))
      else frame.resolve(reply)
    }
  }

  private hold(message: ClientMessage, replyType: ReplyType): Promise<ServerMessage> {
    if (!REPLAYABLE.has(message.t) || this.held.length >= MAX_HELD_FRAMES) {
      return Promise.reject(brokerRestartingError(message.t))
    }
    return new Promise((resolve, reject) => this.held.push({ message, replyType, resolve, reject }))
  }

  private rejectHeld(err: Error): void {
    for (const frame of this.held.splice(0)) frame.reject(err)
  }

  private failAllWaiters(err: Error): void {
    for (const queue of this.waiters.values()) {
      while (queue.length > 0) queue.shift()?.reject(err)
    }
  }

  private tryConnect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath())
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  /** Starts a broker detached, so it outlives whichever session happened to spawn it. */
  private spawnBroker(): void {
    fs.mkdirSync(home(), { recursive: true })
    spawn(process.execPath, [cliEntry(), 'broker'], { detached: true, stdio: 'ignore' }).unref()
  }

  /**
   * A caller retrying its way back onto the bus cannot see whether a drop
   * already reconnected underneath it, or is already climbing the ladder for
   * it — `onDrop`'s reconnect and an external caller like `retryRegistration`
   * can both call this while the socket is still null. Attaching a second
   * socket would strand the first one, which is the one holding this
   * session's registration, so a caller that arrives mid-ladder joins the
   * attempt already running instead of starting a second one alongside it.
   */
  async connect(): Promise<void> {
    if (this.socket !== null) return
    if (this.connecting) return this.connecting
    this.connecting = this.climbLadder()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private async climbLadder(): Promise<void> {
    try {
      this.attach(await this.tryConnect())
      return
    } catch {
      if (this.options.autoStart !== false) this.spawnBroker()
    }
    for (const delay of RECONNECT_DELAYS_MS) {
      await wait(delay)
      if (this.closed) throw new Error('broker client closed')
      try {
        this.attach(await this.tryConnect())
        return
      } catch {
        // keep retrying until the delay budget runs out
      }
    }
    throw new Error('could not reach or start the agent-chat broker')
  }

  /** Fire-and-forget: for messages the broker does not answer. */
  async send(message: ClientMessage): Promise<void> {
    if (this.reconnecting) throw brokerRestartingError(message.t)
    this.socket?.write(encode(message))
  }

  request(message: ClientMessage, replyType: ReplyType): Promise<ServerMessage> {
    if (message.t === 'register') {
      const { t: _kind, ...identity } = message
      this.identity = identity
    }
    if (this.reconnecting) return this.hold(message, replyType)
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket) return reject(new Error('not connected to the broker'))

      const queue = this.waiters.get(replyType) ?? []
      // Cleared on reply, otherwise a resolved request would hold the event
      // loop open for the full timeout and delay short-lived CLI commands.
      const timer = setTimeout(() => {
        const index = queue.indexOf(waiter)
        if (index !== -1) {
          queue.splice(index, 1)
          reject(new Error(`broker did not answer ${replyType}`))
        }
      }, REPLY_TIMEOUT_MS[replyType] ?? REQUEST_TIMEOUT_MS)

      const waiter: Waiter = {
        resolve: msg => {
          clearTimeout(timer)
          resolve(msg)
        },
        reject: err => {
          clearTimeout(timer)
          reject(err)
        },
      }
      queue.push(waiter)
      this.waiters.set(replyType, queue)
      socket.write(encode(message))
    })
  }

  close(): void {
    this.closed = true
    this.socket?.destroy()
    this.rejectHeld(new Error('broker client closed'))
  }
}
