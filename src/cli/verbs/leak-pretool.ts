import { Worker } from 'node:worker_threads'
import { decideWithin, failOpenLogger } from '../../leak-guard/failopen.js'
import { crashDenial, denyOutput, timeoutDenial } from '../../leak-guard/pretool.js'
import { leakGuardLogPath } from '../../paths.js'
import { integrityDenial } from './leak-integrity.js'
import { readStdin } from './permission-hook.js'

/**
 * Under the 15 s the hook settings give Claude Code (PRETOOL_TIMEOUT_S), which would kill the hook
 * with no word. The worker keeps a long synchronous parse off this thread, so the timer still fires.
 */
export const DECISION_DEADLINE_MS = 12_000

function decideInWorker(raw: string, logFile: string): { run: Promise<string>; stop: () => void } {
  const worker = new Worker(new URL('../../leak-guard/pretool-worker.js', import.meta.url), {
    workerData: { raw, logFile, entry: process.argv[1] },
  })
  const run = new Promise<string>((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => reject(new Error(`worker exited ${code}`)))
  })
  return { run, stop: () => void worker.terminate() }
}

/** The hook's stdout for one PreToolUse input: '' to allow, else a deny. A check past `deadlineMs` denies (CC-1407). */
export async function decidePretool(
  raw: string,
  logFile: string,
  deadlineMs = DECISION_DEADLINE_MS,
): Promise<string> {
  const { run, stop } = decideInWorker(raw, logFile)
  const onCrash = (): string | undefined => crashDenial(raw)
  const deadline = { ms: deadlineMs, denial: timeoutDenial }
  const out = await decideWithin(() => run, deadline, failOpenLogger(logFile), onCrash)
  stop()
  return out
}

export interface PretoolIo {
  readInput: () => Promise<string>
  write: (text: string, done: () => void) => void
  exit: (code: number) => void
}

const processIo: PretoolIo = {
  readInput: readStdin,
  write: (text, done) => void process.stdout.write(text, done),
  exit: code => process.exit(code),
}

/**
 * `agent-chat leak-guard pretool`: the PreToolUse hook every spawned agent runs (CC-270). It exits
 * from the write callback: worker.terminate() cannot interrupt a native sync call, so a worker
 * stuck in one would otherwise keep the process alive past the harness deadline (CC-1409).
 * With `nonce` the shell-file check runs beside the guard, and a deny from either one denies.
 */
export async function leakPretool(
  io: PretoolIo = processIo,
  nonce?: string,
  check: typeof integrityDenial = integrityDenial,
): Promise<void> {
  const raw = await io.readInput()
  const [guard, integrity] = await Promise.all([
    decidePretool(raw, leakGuardLogPath()),
    nonce === undefined ? undefined : check(nonce, raw),
  ])
  const out = integrity === undefined ? guard : denyOutput(integrity)
  if (out === '') io.exit(0)
  else io.write(`${out}\n`, () => io.exit(0))
}

/** `agent-chat leak-guard posttool --integrity <nonce>`: the same check after the call, told to the model as a block. */
export async function leakPosttool(
  nonce: string,
  io: PretoolIo = processIo,
  check: typeof integrityDenial = integrityDenial,
): Promise<void> {
  const reason = await check(nonce, await io.readInput())
  if (reason === undefined) io.exit(0)
  else io.write(`${JSON.stringify({ decision: 'block', reason })}\n`, () => io.exit(0))
}
