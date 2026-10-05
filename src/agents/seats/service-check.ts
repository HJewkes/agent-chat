import { execFile } from 'node:child_process'

/**
 * CC-598: each watchdog pass asks `titan-factory service check --json` whether the factory
 * service is healthy, and the attended seats hear of a cause once, not on every pass.
 */

export const SERVICE_CHECK_TIMEOUT_MS = 5_000

/** What the check printed and how it ended; `error` is set when it could not run at all. */
export interface ServiceCheckRun {
  exitCode: number | undefined
  stdout: string
  error?: string
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

/** The one cause line for a failing check; undefined when the service is healthy. */
export function serviceCause(run: ServiceCheckRun): string | undefined {
  if (run.error !== undefined) return `service check could not run: ${run.error}`
  if (run.exitCode === 0) return undefined
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

/** The live runner: a missing binary or a timeout is reported in `error`, never thrown. */
export const execServiceCheck: ServiceCheckRunner = () =>
  new Promise(resolve => {
    execFile(
      'titan-factory',
      ['service', 'check', '--json'],
      { timeout: SERVICE_CHECK_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err === null) return resolve({ exitCode: 0, stdout })
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
        if (typeof code === 'number') return resolve({ exitCode: code, stdout })
        const timedOut = (err as { killed?: boolean }).killed === true
        resolve({
          exitCode: undefined,
          stdout,
          error: timedOut ? `timed out after ${SERVICE_CHECK_TIMEOUT_MS} ms` : err.message,
        })
      },
    )
  })
