import net from 'node:net'
import { EXIT } from '@titan-design/registry'
import { BrokerClient } from '../client/broker-client.js'
import { socketPath } from '../paths.js'

/** Exit status a caller can key on to tell a down broker from any other failure. */
export const BROKER_UNAVAILABLE_EXIT = EXIT.UNAVAILABLE

/** Thrown instead of autostarting when `AGENT_CHAT_NO_AUTOSTART=1` finds no broker. */
export class BrokerUnavailableError extends Error {
  readonly code = BROKER_UNAVAILABLE_EXIT
  constructor() {
    super('broker unavailable: no broker is listening and AGENT_CHAT_NO_AUTOSTART=1 forbids starting one')
    this.name = 'BrokerUnavailableError'
  }
}

const probeBroker = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath())
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', () => reject(new BrokerUnavailableError()))
  })

/** Short-lived client for the one-shot CLI verbs. */
export async function withBroker<T>(fn: (broker: BrokerClient) => Promise<T>): Promise<T> {
  if (process.env.AGENT_CHAT_NO_AUTOSTART === '1') await probeBroker()
  const broker = new BrokerClient(() => undefined)
  await broker.connect()
  try {
    return await fn(broker)
  } finally {
    broker.close()
  }
}

export const ago = (at: number): string => {
  const ms = Date.now() - at
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

/** Every verb that reports a broker refusal exits non-zero on it; this is that shape. */
export function fail(reason: string): never {
  console.error(reason)
  process.exit(1)
}
