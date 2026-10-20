import type { EventEmitter } from 'node:events'
import { logEvent } from './log.js'

type CrashKind = 'uncaughtException' | 'unhandledRejection'

const describe = (err: unknown): Record<string, string> =>
  err instanceof Error ? { error: err.message, stack: err.stack ?? '' } : { error: String(err) }

/**
 * CC-1505: the broker runs with its stdio discarded, so a throw nothing caught left
 * no trace beyond a missing `broker_stopping`. This records it in broker.log, then
 * exits non-zero as Node would have.
 */
export function installCrashLog(
  proc: EventEmitter = process,
  exit: (code: number) => void = code => process.exit(code),
): void {
  const crash =
    (kind: CrashKind) =>
    (err: unknown): void => {
      logEvent('broker_crashed', { kind, pid: process.pid, ...describe(err) })
      exit(1)
    }
  proc.on('uncaughtException', crash('uncaughtException'))
  proc.on('unhandledRejection', crash('unhandledRejection'))
}
