import { execFile } from 'node:child_process'
import path from 'node:path'
import { logEvent } from './log.js'

/**
 * TP-4867: a claim that ends frees work the burndown timer would leave idle until its next tick.
 * When `claimWake` is set, the broker runs its argv (for example `systemctl --user start --no-block
 * agent-chat-burndown.service`) once per settle window, the claim-side twin of Shepherd's merge wake
 * (TP-1433). Unset, nothing runs. The timer stays the backstop, so a failed or dropped wake only delays.
 */

export const DEFAULT_CLAIM_WAKE_SETTLE_MS = 20_000
/** Matches the merge wake's cap: a window longer than the wake's own deadline is read as a typo. */
export const MAX_CLAIM_WAKE_SETTLE_MS = 30_000
export const DEFAULT_CLAIM_WAKE_TIMEOUT_MS = 10_000

export interface ClaimWakeConfig {
  argv: [string, ...string[]]
  cwd?: string
  timeoutMs: number
  settleMs: number
}

/** The parsed `claimWake` value, or a reason it is refused. */
export function parseClaimWake(value: unknown): ClaimWakeConfig | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be an object'
  const { argv, cwd, timeoutMs, settleMs, ...rest } = value as Record<string, unknown>
  const unknownKeys = Object.keys(rest)
  if (unknownKeys.length > 0) return `unknown keys: ${unknownKeys.join(', ')}`
  if (!isArgv(argv)) return 'argv must be a non-empty array of strings without NUL, argv[0] naming a program'
  if (cwd !== undefined && !(typeof cwd === 'string' && path.isAbsolute(cwd)))
    return 'cwd must be an absolute path'
  if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) return 'timeoutMs must be a positive integer'
  if (settleMs !== undefined && !(isPositiveInteger(settleMs) && settleMs <= MAX_CLAIM_WAKE_SETTLE_MS))
    return `settleMs must be a positive integer at most ${MAX_CLAIM_WAKE_SETTLE_MS}`
  return {
    argv,
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: timeoutMs ?? DEFAULT_CLAIM_WAKE_TIMEOUT_MS,
    settleMs: settleMs ?? DEFAULT_CLAIM_WAKE_SETTLE_MS,
  }
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1

function isArgv(value: unknown): value is [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every(word => typeof word === 'string' && !word.includes('\0'))) return false
  return (value[0] as string).length > 0
}

/** Absorbs claim ends into one wake per window. */
export interface ClaimWake {
  event(): void
}

/** The slice of `child_process.execFile` the wake uses, so tests replace it at the boundary. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeout: number; windowsHide: boolean },
  callback: (error: (Error & { code?: unknown; signal?: unknown; killed?: boolean }) | null) => void,
) => unknown

export interface ClaimWakePorts {
  /** The current config, read when a window arms so an edit needs no broker restart. */
  resolve: () => ClaimWakeConfig | undefined
  execFile?: ExecFileFn
  log?: (event: string, detail: Record<string, unknown>) => void
  /** Absent means an unref'd setTimeout, so a pending wake never holds the broker open. */
  setTimer?: (run: () => void, ms: number) => void
}

/** The first claim end arms the window; ends inside it are absorbed, and the wake runs once when it closes. */
export function claimWake(ports: ClaimWakePorts): ClaimWake {
  const { resolve, execFile: exec = execFile as unknown as ExecFileFn, log = logEvent } = ports
  const setTimer = ports.setTimer ?? ((run, ms) => void setTimeout(run, ms).unref())
  let armed = false
  return {
    event() {
      if (armed) return
      const config = resolve()
      if (config === undefined) return
      armed = true
      setTimer(() => {
        armed = false
        run(config, exec, log)
      }, config.settleMs)
    },
  }
}

/** No shell and no wait: the outcome goes to broker.log when the child ends or the timeout kills it. */
function run(config: ClaimWakeConfig, exec: ExecFileFn, log: NonNullable<ClaimWakePorts['log']>): void {
  const [file, ...args] = config.argv
  const options = {
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    timeout: config.timeoutMs,
    windowsHide: true,
  }
  try {
    exec(file, args, options, error => {
      if (error === null) return log('claim_wake_ran', { argv: config.argv })
      log('claim_wake_failed', {
        argv: config.argv,
        error: error.message,
        code: error.code,
        signal: error.signal,
        timedOut: error.killed === true,
      })
    })
  } catch (error) {
    log('claim_wake_failed', { argv: config.argv, error: String(error) })
  }
}
