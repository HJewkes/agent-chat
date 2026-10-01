import { Worker } from 'node:worker_threads'
import { decideWithin, failOpenLogger } from '../../leak-guard/failopen.js'
import { leakGuardLogPath } from '../../paths.js'
import { readStdin } from './permission-hook.js'

/** Under the 15 s the hook settings give Claude Code, which would kill the hook with no word. */
const DECISION_DEADLINE_MS = 12_000

function decideInWorker(raw: string, logFile: string): { run: Promise<string>; stop: () => void } {
  const worker = new Worker(new URL('../../leak-guard/pretool-worker.js', import.meta.url), {
    workerData: { raw, logFile },
  })
  const run = new Promise<string>((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => reject(new Error(`worker exited ${code}`)))
  })
  return { run, stop: () => void worker.terminate() }
}

/** `agent-chat leak-guard pretool`: the PreToolUse hook every spawned agent runs (CC-270). */
export async function leakPretool(): Promise<void> {
  const logFile = leakGuardLogPath()
  const { run, stop } = decideInWorker(await readStdin(), logFile)
  const out = await decideWithin(() => run, DECISION_DEADLINE_MS, failOpenLogger(logFile))
  stop()
  if (out !== '') process.stdout.write(`${out}\n`)
}
