import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveGhWriteGapMs } from '../config.js'
import { ghWrite, type GhResult } from '../gh-write/throttle.js'
import { ghWriteLockPath, ghWriteStampPath } from '../paths.js'

/**
 * stdin is not forwarded: a retry would replay an already-drained pipe. Send
 * request bodies with `-f`/`-F` or `--input <file>`.
 */
function runGh(args: string[]): Promise<GhResult> {
  return new Promise(resolve => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const collected = (code: number, extra = '') => ({
      code,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat([...stderr, Buffer.from(extra)]),
    })
    child.on('error', err => resolve(collected(127, `gh-write: ${err.message}\n`)))
    child.on('close', code => resolve(collected(code ?? 1)))
  })
}

async function coreRemaining(): Promise<number | undefined> {
  const { code, stdout } = await runGh(['api', 'rate_limit', '--jq', '.resources.core.remaining'])
  const remaining = Number.parseInt(stdout.toString(), 10)
  return code === 0 && Number.isInteger(remaining) ? remaining : undefined
}

export async function ghWriteCommand(args: string[]): Promise<void> {
  const result = await ghWrite(args, {
    now: Date.now,
    sleep: ms => sleep(ms),
    runGh,
    coreRemaining,
    notice: line => process.stderr.write(`${line}\n`),
    lockDir: ghWriteLockPath(),
    stampPath: ghWriteStampPath(),
    gapMs: resolveGhWriteGapMs(),
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.code
}
