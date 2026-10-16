import { appendCall, type GhCallLine } from '../../gh-calls/log.js'
import { shimCallLine } from '../../gh-shim/call-log.js'
import { callShape } from '../../gh-shim/call-shape.js'
import { run as baseRun, type Runner } from '../../exec.js'

// Kept so burndown and its tests need no import churn during the NA3 port freeze; C3 (CC-1197) removes it.
export {
  IDENTITY_ENV,
  childEnv,
  describeExecFailure,
  type ExecFailureContext,
  type RunOptions,
  type RunResult,
  type Runner,
} from '../../exec.js'

export const BURNDOWN_CALLER = 'burndown-tick'

export type GhCallSink = (line: GhCallLine) => void

const fileSink: GhCallSink = line => void appendCall(line)

/**
 * Wraps a runner so every `gh` call that reaches GitHub appends one gh-calls v1 line (TP-1172 c).
 * Stderr is only classified into `limit`, never stored, since it can quote content.
 */
export function loggingRunner(
  inner: Runner,
  sink: GhCallSink = fileSink,
  clock: () => number = Date.now,
): Runner {
  return (bin, args, cwd, options) => {
    const shape = bin === 'gh' ? callShape(args) : undefined
    if (shape === undefined) return inner(bin, args, cwd, options)
    const started = clock()
    const result = inner(bin, args, cwd, options)
    const outcome = {
      exitCode: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      ms: clock() - started,
    }
    sink(shimCallLine(BURNDOWN_CALLER, shape, outcome))
    return result
  }
}

export const run: Runner = loggingRunner(baseRun)
