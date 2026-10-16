import { Worker } from 'node:worker_threads'
import { decideWithin, failOpenLogger } from '../../leak-guard/failopen.js'
import { crashDenial, timeoutDenial } from '../../leak-guard/pretool.js'
import { leakGuardLogPath } from '../../paths.js'
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

/** `agent-chat leak-guard pretool`: the PreToolUse hook every spawned agent runs (CC-270). */
export async function leakPretool(): Promise<void> {
  const out = await decidePretool(await readStdin(), leakGuardLogPath())
  if (out !== '') process.stdout.write(`${out}\n`)
}
