import os from 'node:os'
import { parentPort, workerData } from 'node:worker_threads'
import { failOpenLogger } from './failopen.js'
import { guardContext, pretoolDecision } from './pretool.js'

/** The pretool decision off the main thread, so a deadline can fire while it runs synchronous git calls. */
// A worker's own argv[1] is this file, so the hook's entry script comes from the main thread.
const { raw, logFile, entry } = workerData as { raw: string; logFile: string; entry?: string }
const build = (cwd: string): ReturnType<typeof guardContext> =>
  guardContext(process.env, cwd, os.homedir(), entry)
parentPort?.postMessage(pretoolDecision(raw, build, failOpenLogger(logFile)))
