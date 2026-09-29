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
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', err => resolve({ code: 127, stdout, stderr: `${stderr}gh-write: ${err.message}\n` }))
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function coreRemaining(): Promise<number | undefined> {
  const { code, stdout } = await runGh(['api', 'rate_limit', '--jq', '.resources.core.remaining'])
  const remaining = Number.parseInt(stdout, 10)
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
