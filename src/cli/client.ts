import { BrokerClient } from '../client/broker-client.js'

/** Short-lived client for the one-shot CLI verbs. */
export async function withBroker<T>(fn: (broker: BrokerClient) => Promise<T>): Promise<T> {
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
