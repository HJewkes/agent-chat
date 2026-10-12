import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseIncluded, restRead, type CallLogger } from './call-log.js'
import type { ShimIo } from './commands.js'

const realDir = (dir: string): string => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The first `name` on PATH outside `skipDir`, so the shim never resolves to itself. */
export function findOnPath(name: string, pathVar: string | undefined, skipDir?: string): string | undefined {
  const skip = skipDir === undefined ? undefined : realDir(skipDir)
  for (const dir of (pathVar ?? '').split(path.delimiter)) {
    if (dir === '' || (skip !== undefined && realDir(dir) === skip)) continue
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

const MAX_BUFFER = 64 * 1024 * 1024

/** `-i` puts the status and rate-limit headers ahead of the body; a failed call is logged before it throws. */
function ghApi(realGh: string, apiPath: string, log: CallLogger): unknown {
  const started = Date.now()
  const result = spawnSync(realGh, ['api', apiPath, '-i'], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error === undefined) {
    log(restRead(apiPath), { exitCode: result.status ?? 1, stdout, stderr, ms: Date.now() - started })
  }
  if (result.status !== 0) throw new Error(`gh api ${apiPath}: ${stderr || 'failed'}`)
  return JSON.parse(parseIncluded(stdout)?.body ?? stdout)
}

/** gh's `--jq` prints strings raw and everything else as compact JSON, which is `jq -rc`. */
function runJq(jqBin: string, value: unknown, expr: string): string {
  const result = spawnSync(jqBin, ['-rc', expr], { input: JSON.stringify(value), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`jq: ${result.stderr}`)
  return result.stdout
}

function currentBranch(): string | undefined {
  const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() || undefined : undefined
}

/** Output is held until the command succeeds, so a fall-back to the real gh never follows partial output. */
export interface BufferedIo extends ShimIo {
  flush: () => void
}

export function processIo(realGh: string, jqBin: string | undefined, log: CallLogger): BufferedIo {
  const out: string[] = []
  const err: string[] = []
  return {
    api: apiPath => ghApi(realGh, apiPath, log),
    currentBranch,
    jq: (value, expr) => {
      if (jqBin === undefined) throw new Error('jq not on PATH')
      return runJq(jqBin, value, expr)
    },
    out: text => void out.push(text),
    err: text => void err.push(text),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    flush: () => {
      process.stdout.write(out.join(''))
      process.stderr.write(err.join(''))
    },
  }
}
