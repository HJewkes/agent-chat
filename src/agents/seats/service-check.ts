import { execFile, type ExecFileException } from 'node:child_process'

/**
 * CC-598: each watchdog pass asks `titan-factory service check --json` whether the factory
 * service is healthy, and the attended seats hear of a cause once, not on every pass.
 */

/** CC-1125: above the check's worst case of 21 s, so a slow serve is not read as a check that could not run. */
export const SERVICE_CHECK_TIMEOUT_MS = 30_000

/** What the check printed and how it ended; `error` is set when it could not run at all. */
export interface ServiceCheckRun {
  exitCode: number | undefined
  stdout: string
  error?: string
  /** The check was killed for outliving its timeout: serve did not answer. */
  timedOut?: boolean
}

export type ServiceCheckRunner = () => Promise<ServiceCheckRun>

/** A throw is a cause too, so a broken runner never ends the pass. */
export async function runServiceCheck(runner: ServiceCheckRunner): Promise<ServiceCheckRun> {
  try {
    return await runner()
  } catch (err) {
    return { exitCode: undefined, stdout: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/** CC-693: an exit 0 is healthy only when it printed a JSON object that does not say `ok: false`. */
function exitZeroCause(stdout: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return 'unparsed: service check exited 0 but printed no JSON'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return 'unparsed: service check exited 0 but printed no JSON object'
  const { ok, cause } = parsed as { ok?: unknown; cause?: unknown }
  if (ok !== false) return undefined
  return typeof cause === 'string' && cause !== ''
    ? `not-ok: ${cause}`
    : 'not-ok: service check said ok: false'
}

/** The one cause line for a failing check; undefined when the service is healthy. */
export function serviceCause(run: ServiceCheckRun): string | undefined {
  if (run.timedOut === true) return `unresponsive: no answer within ${SERVICE_CHECK_TIMEOUT_MS} ms`
  if (run.error !== undefined) return `service check could not run: ${run.error}`
  if (run.exitCode === 0) return exitZeroCause(run.stdout)
  try {
    const parsed: unknown = JSON.parse(run.stdout)
    const cause = (parsed as { cause?: unknown } | null)?.cause
    if (typeof cause === 'string' && cause !== '') return cause
  } catch {
    // Falls through: a non-JSON answer is its own cause.
  }
  return 'service check answered with no readable cause'
}

export interface ServiceNotice {
  /** The cause to remember for the next pass; undefined once the service is healthy. */
  cause: string | undefined
  /** The message to send the attended seats; undefined when nothing changed. */
  message: string | undefined
}

export function judgeService(previous: string | undefined, run: ServiceCheckRun): ServiceNotice {
  const cause = serviceCause(run)
  if (cause === previous) return { cause, message: undefined }
  if (cause === undefined) return { cause, message: 'Watchdog: titan-factory service recovered' }
  return { cause, message: `Watchdog: titan-factory service check failing: ${cause}` }
}

/** The slice of `execFile` the runner uses, so a test can stand in for the process. */
export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; encoding: 'utf8' },
  callback: (err: ExecFileException | null, stdout: string) => void,
) => void

/** CC-693: a missing binary and an output overflow each read as their own error. */
function execError(err: ExecFileException): string {
  if (err.code === 'ENOENT') return 'titan-factory not found (ENOENT)'
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output overflowed the buffer'
  return err.message
}

/** An overflow also kills the child, so only a kill with no string code is the timeout (node leaves `code` null). */
const isTimeout = (err: ExecFileException): boolean => err.killed === true && typeof err.code !== 'string'

/** A runner over `exec`: a missing binary or a timeout is reported, never thrown. */
export function serviceCheckRunner(exec: ExecFile): ServiceCheckRunner {
  return () =>
    new Promise(resolve => {
      exec(
        'titan-factory',
        ['service', 'check', '--json'],
        { timeout: SERVICE_CHECK_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout) => {
          if (err === null) return resolve({ exitCode: 0, stdout })
          if (typeof err.code === 'number') return resolve({ exitCode: err.code, stdout })
          if (isTimeout(err)) return resolve({ exitCode: undefined, stdout, timedOut: true })
          resolve({ exitCode: undefined, stdout, error: execError(err) })
        },
      )
    })
}

export const execServiceCheck: ServiceCheckRunner = serviceCheckRunner((file, args, options, callback) => {
  execFile(file, args, options, callback)
})
