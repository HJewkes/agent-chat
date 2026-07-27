import net from 'node:net'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  encode,
  lineReader,
  type ClientMessage,
  type DeliveredMessage,
  type ReplyType,
  type ServerMessage,
} from '../protocol.js'
import { home, socketPath } from '../paths.js'

const REQUEST_TIMEOUT_MS = 5000
const RECONNECT_DELAYS_MS = [100, 250, 500, 1000, 2000, 5000]

type Waiter = (msg: ServerMessage) => void

/**
 * What gets replayed on reconnect. `agentId` is in here deliberately: a broker
 * restart that replayed only the name would reattach the process as an ordinary
 * session, and the durable agent would go quietly missing from the roster at
 * exactly the moment the roster is meant to be the trustworthy view.
 */
type Identity = Omit<Extract<ClientMessage, { t: 'register' }>, 't'>

const brokerEntry = (): string => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js')

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A session's connection to the broker. Reconnects on drop and replays its
 * registration, so a broker restart doesn't strand the session.
 */
export class BrokerClient {
  private socket: net.Socket | null = null
  private identity: Identity | null = null
  private closed = false
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
  ) {}

  private handle(msg: ServerMessage): void {
    if (msg.t === 'deliver') return this.onDeliver(msg.message)
    if (msg.t === 'error') {
      if (!msg.fatal) return
      // Set before destroying, so the close handler sees a deliberate shutdown
      // and does not climb the reconnect ladder.
      this.closed = true
      this.socket?.destroy()
      this.socket = null
      this.failAllWaiters(msg.reason)
      this.onFatal?.(msg.reason)
      return
    }
    const queue = this.waiters.get(msg.t)
    queue?.shift()?.(msg)
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

  private async onDrop(): Promise<void> {
    if (this.closed || this.socket === null) return
    this.socket = null
    this.failAllWaiters('broker connection lost')
    await this.connect()
    if (this.identity) await this.request({ t: 'register', ...this.identity }, 'register_result')
  }

  private failAllWaiters(reason: string): void {
    for (const queue of this.waiters.values()) {
      while (queue.length > 0) queue.shift()?.({ t: 'error', reason } as ServerMessage)
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
    spawn(process.execPath, [brokerEntry(), 'broker'], { detached: true, stdio: 'ignore' }).unref()
  }

  async connect(): Promise<void> {
    try {
      this.attach(await this.tryConnect())
      return
    } catch {
      this.spawnBroker()
    }
    for (const delay of RECONNECT_DELAYS_MS) {
      await wait(delay)
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
    this.socket?.write(encode(message))
  }

  request(message: ClientMessage, replyType: ReplyType): Promise<ServerMessage> {
    if (message.t === 'register') {
      const { t: _kind, ...identity } = message
      this.identity = identity
    }
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
      }, REQUEST_TIMEOUT_MS)

      const waiter: Waiter = msg => {
        clearTimeout(timer)
        resolve(msg)
      }
      queue.push(waiter)
      this.waiters.set(replyType, queue)
      socket.write(encode(message))
    })
  }

  close(): void {
    this.closed = true
    this.socket?.destroy()
  }
}
