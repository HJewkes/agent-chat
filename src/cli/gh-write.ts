import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveGhWriteGapMs } from '../config.js'
import { defaultTermsFile, prepareGhWrite, scanDeps, type ScanDeps } from '../gh-write/scan.js'
import { ghWrite, type GhResult, type ThrottleDeps } from '../gh-write/throttle.js'
import { currentCooldowns, writeLane } from '../gh-shim/rate-limit.js'
import { ghWriteLockPath, ghWriteStampPath } from '../paths.js'

/**
 * gh never gets stdin: a retry would replay an already-drained pipe. `--body-file -`,
 * `--input -` and `-F key=@-` are read once by the scan and reach gh as a file copy.
 */
export function runGh(args: string[]): Promise<GhResult> {
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

/**
 * `/rate_limit` never shows the secondary limit (CC-1162), so the shared cooldown answers instead:
 * 0 while a primary limit cools the REST lane, else unknown, which lets the write retry.
 */
export const stateCoreRemaining =
  (env: NodeJS.ProcessEnv, now: () => number) => async (): Promise<number | undefined> =>
    (await currentCooldowns(env, now())).rest?.class === 'primary' ? 0 : undefined

/** When the shared cooldown on the write's lane ends; 0 when the lane is open. */
export const stateCooldownEnd =
  (env: NodeJS.ProcessEnv, now: () => number) =>
  async (args: string[]): Promise<number> =>
    (await currentCooldowns(env, now()))[writeLane(args)]?.until ?? 0

/** Scans the text gh would post and refuses with exit 1 before gh starts on a finding. */
export async function runGhWrite(args: string[], scan: ScanDeps, throttle: ThrottleDeps): Promise<GhResult> {
  const prepared = await prepareGhWrite(args, scan)
  if ('reason' in prepared)
    return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(`${prepared.reason}\n`) }
  try {
    return await ghWrite(prepared.args, throttle)
  } finally {
    prepared.cleanup()
  }
}

export async function ghWriteCommand(args: string[]): Promise<void> {
  const result = await runGhWrite(args, scanDeps(defaultTermsFile()), {
    now: Date.now,
    sleep: ms => sleep(ms),
    runGh,
    coreRemaining: stateCoreRemaining(process.env, Date.now),
    cooldownEnd: stateCooldownEnd(process.env, Date.now),
    notice: line => process.stderr.write(`${line}\n`),
    lockDir: ghWriteLockPath(),
    stampPath: ghWriteStampPath(),
    gapMs: resolveGhWriteGapMs(),
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.code
}
