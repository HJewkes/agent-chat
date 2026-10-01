import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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

function ghApi(realGh: string, apiPath: string): unknown {
  const result = spawnSync(realGh, ['api', apiPath], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  if (result.status !== 0) throw new Error(`gh api ${apiPath}: ${result.stderr || 'failed'}`)
  return JSON.parse(result.stdout)
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

export function processIo(realGh: string, jqBin: string | undefined): BufferedIo {
  const out: string[] = []
  const err: string[] = []
  return {
    api: apiPath => ghApi(realGh, apiPath),
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
