import os from 'node:os'
import { parentPort, workerData } from 'node:worker_threads'
import { failOpenLogger } from './failopen.js'
import { guardContext, pretoolDecision } from './pretool.js'

/** The pretool decision off the main thread, so a deadline can fire while it runs synchronous git calls. */
const { raw, logFile } = workerData as { raw: string; logFile: string }
const build = (cwd: string): ReturnType<typeof guardContext> => guardContext(process.env, cwd, os.homedir())
parentPort?.postMessage(pretoolDecision(raw, build, failOpenLogger(logFile)))
