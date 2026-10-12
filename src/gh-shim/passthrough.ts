import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { CallLogger } from './call-log.js'
import { callShape } from './call-shape.js'

/**
 * Runs the real gh for every command the shim does not answer, and logs the call (TP-1172 b).
 *
 * Stdout and stderr are piped so the shim can read the status, and written through chunk by chunk
 * as they arrive, so the bytes and their pacing are what gh printed. On a terminal gh changes its
 * output format, so there the streams stay inherited and the line carries only the exit status.
 */

/** Enough for an `-i` header block and a GitHub error message; the rest is only passed on. */
const CAPTURE_LIMIT = 64 * 1024

const tee = (from: Readable, to: Writable): (() => string) => {
  const kept: Buffer[] = []
  let size = 0
  from.on('data', (chunk: Buffer) => {
    if (size < CAPTURE_LIMIT) kept.push(chunk)
    size += chunk.length
  })
  // A reader that hangs up (`gh ... | head`) closes our end too, so gh sees the broken pipe it would have.
  to.once('error', () => from.destroy())
  from.pipe(to, { end: false })
  return () => Buffer.concat(kept).toString('utf8')
}

const onTerminal = (): boolean => process.stdout.isTTY === true || process.stderr.isTTY === true

export async function passThrough(realGh: string, argv: readonly string[], log: CallLogger): Promise<number> {
  const started = Date.now()
  const piped = !onTerminal()
  const child = spawn(realGh, argv, { stdio: piped ? ['inherit', 'pipe', 'pipe'] : 'inherit' })
  const stdout = piped && child.stdout !== null ? tee(child.stdout, process.stdout) : () => ''
  const stderr = piped && child.stderr !== null ? tee(child.stderr, process.stderr) : () => ''
  const exitCode = await new Promise<number | 'unstarted'>(resolve => {
    child.on('error', () => resolve('unstarted'))
    child.on('close', code => resolve(code ?? 1))
  })
  if (exitCode === 'unstarted') return 1
  const shape = callShape(argv)
  if (shape !== undefined)
    log(shape, { exitCode, stdout: stdout(), stderr: stderr(), ms: Date.now() - started })
  return exitCode
}
