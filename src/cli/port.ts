import { z } from 'zod'
import { EXIT } from '@titan-design/registry'
import type { BrokerClient } from '../client/broker-client.js'
import { BrokerUnavailableError } from './client.js'
import type { Report, VerbContext } from './command.js'

/**
 * CC-1194: the JSON face of the burndown tick's broker ports, for a tick that runs
 * out of process. Every `port` verb prints exactly one line in this envelope and
 * never starts a broker, so a caller can key on `error.code` instead of stderr text.
 */
export const PortError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retryAfterMs: z.number().optional(),
  /** The write went out and no reply came, so whether the broker applied it is unknown (CC-640). */
  unknown: z.boolean().optional(),
})
export type PortError = z.infer<typeof PortError>

/** Parse `data` with the verb's own exported output schema. */
export const PortEnvelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: PortError }),
])
export type PortEnvelope = z.infer<typeof PortEnvelope>

/** A broker refusal carried through to `error`, as a spawn's `code`/`retryable`/`retryAfterMs` arrive. */
export class PortRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'PortRefusal'
  }
}

interface PortFailure {
  error: PortError
  exit: number
}

const UNREACHABLE = /^could not reach or start/

function portFailure(err: unknown): PortFailure {
  const message = err instanceof Error ? err.message : String(err)
  // A connect that fails after the probe passed (the broker died between them) is the same outage.
  if (err instanceof BrokerUnavailableError || UNREACHABLE.test(message))
    return { error: { code: 'broker_unavailable', message, retryable: true }, exit: EXIT.UNAVAILABLE }
  if (message.startsWith('broker did not answer'))
    return { error: { code: 'broker_timeout', message, retryable: false, unknown: true }, exit: EXIT.GENERIC }
  if (err instanceof PortRefusal) {
    const retryAfter = err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }
    return { error: { code: err.code, message, retryable: err.retryable, ...retryAfter }, exit: EXIT.GENERIC }
  }
  return { error: { code: 'internal_error', message, retryable: false }, exit: EXIT.GENERIC }
}

/**
 * Runs one port over a connection that is probed first and never autostarts,
 * and folds every outcome into one envelope line. The error message also goes
 * to stderr, where `agent-dispatch` matches broker-down today.
 */
export async function runPort<T>(
  ctx: VerbContext,
  fn: (broker: BrokerClient) => Promise<T>,
): Promise<Report> {
  try {
    const data = await ctx.withBroker(fn, { autoStart: false })
    return { ok: true, lines: [JSON.stringify({ ok: true, data } satisfies PortEnvelope)] }
  } catch (err) {
    const { error, exit } = portFailure(err)
    const envelope: PortEnvelope = { ok: false, error }
    return { ok: false, lines: [JSON.stringify(envelope)], errors: [error.message], exit }
  }
}
