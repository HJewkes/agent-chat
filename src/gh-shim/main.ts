import { spawnSync } from 'node:child_process'
import { parseRequest } from './argv.js'
import { runRequest } from './commands.js'
import { GH_SHIM_DIR_ENV, GH_SHIM_OFF_ENV } from './install.js'
import { findOnPath, processIo } from './io.js'

/**
 * Entry point of the `gh` on a spawned agent's PATH (CC-395).
 *
 * gh's `pr view/list/checks` read through GraphQL, whose hourly points budget every agent on the
 * machine shares; REST has its own, far larger, quota. This answers the read-only shapes agents use
 * from REST and hands every other command, writes included, to the real gh unchanged.
 */

function passThrough(realGh: string, argv: readonly string[]): number {
  const result = spawnSync(realGh, argv, { stdio: 'inherit' })
  return result.status ?? 1
}

async function main(argv: readonly string[]): Promise<number> {
  const realGh = findOnPath('gh', process.env.PATH, process.env[GH_SHIM_DIR_ENV])
  if (realGh === undefined) {
    process.stderr.write('agent-chat gh shim: no gh on PATH besides the shim\n')
    return 127
  }
  const req = process.env[GH_SHIM_OFF_ENV] === '1' ? undefined : parseRequest(argv)
  const jqBin = findOnPath('jq', process.env.PATH)
  if (req === undefined || ('jq' in req && req.jq !== undefined && jqBin === undefined)) {
    return passThrough(realGh, argv)
  }
  const io = processIo(realGh, jqBin)
  try {
    const code = await runRequest(io, req)
    io.flush()
    return code
  } catch {
    return passThrough(realGh, argv)
  }
}

process.exitCode = await main(process.argv.slice(2))
