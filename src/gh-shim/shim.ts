import { leakGuardLogPath } from '../paths.js'
import { parseRequest, type ShimRequest } from './argv.js'
import { fileCallLogger } from './call-log.js'
import { runRequest } from './commands.js'
import { GH_SHIM_DIR_ENV, GH_SHIM_OFF_ENV } from './install.js'
import { gatewayApi } from './gateway.js'
import { findOnPath, processIo } from './io.js'
import { passThrough } from './passthrough.js'
import { shimBudget, type ShimBudget } from './rate-limit.js'
import { GATE_MODE, gateWrite, procParentArgv, type GateMode } from './write-gate.js'

const errOut = (text: string): void => void process.stderr.write(text)

/**
 * The `gh` on a spawned agent's PATH (CC-395); `main.ts` runs it.
 *
 * gh's `pr view/list/checks` read through GraphQL, whose hourly points budget every agent on the
 * machine shares; REST has its own, far larger, quota. This answers the read-only shapes agents use
 * from REST and hands every other known read, and every write gh-write sent with its ticket
 * (CC-1644), to the real gh unchanged; any other command is refused before it starts, or under
 * `GATE_MODE` 'log' runs with a would-refuse line. Every real-gh
 * call, answered or passed through, gets one gh-calls line (TP-1172 b), and a call a rate limit
 * refused starts the shared cooldown that later reads respect (CC-1162). Answers read through
 * Shepherd serve's gateway first (CC-1178), so they are not gated up front: the gateway serves
 * reads during a cooldown, and a direct read checks the cooldown itself.
 */

/** A shim answer that fails falls back to the real gh, unless the failure was a limit that now cools the lane. */
async function answer(
  realGh: string,
  argv: readonly string[],
  req: ShimRequest,
  budget: ShimBudget,
): Promise<number> {
  const direct = processIo(realGh, findOnPath('jq', process.env.PATH), budget.log)
  const io = { ...direct, api: gatewayApi(process.env, direct.api, direct.err) }
  try {
    const code = await runRequest(io, req)
    io.flush()
    return code
  } catch {
    return (await budget.gate()) ?? passThrough(realGh, argv, budget.log)
  }
}

/** `mode` is a parameter only so tests can drive both; the entry point always passes `GATE_MODE`. */
export async function runShim(argv: readonly string[], mode: GateMode = GATE_MODE): Promise<number> {
  const io = {
    env: process.env,
    now: Date.now(),
    logFile: leakGuardLogPath(),
    stderr: errOut,
    mode,
    parentArgv: () => procParentArgv(),
  }
  const refused = gateWrite(argv, io)
  if (refused !== undefined) return refused
  const realGh = findOnPath('gh', process.env.PATH, process.env[GH_SHIM_DIR_ENV])
  if (realGh === undefined) {
    process.stderr.write('agent-chat gh shim: no gh on PATH besides the shim\n')
    return 127
  }
  const off = process.env[GH_SHIM_OFF_ENV] === '1'
  const req = off ? undefined : parseRequest(argv)
  const jqBin = findOnPath('jq', process.env.PATH)
  const log = fileCallLogger(process.env)
  const budget = shimBudget(argv, { env: process.env, realGh, jqBin, log, enforce: !off })
  try {
    if (req !== undefined && !('jq' in req && req.jq !== undefined && jqBin === undefined)) {
      return await answer(realGh, argv, req, budget)
    }
    return (await budget.gate()) ?? (await passThrough(realGh, argv, budget.log))
  } finally {
    await budget.settled()
  }
}
