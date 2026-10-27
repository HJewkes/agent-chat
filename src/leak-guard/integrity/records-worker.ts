import { parentPort, workerData } from 'node:worker_threads'
import { currentRecords } from './env-records.js'

/** The hook's records off the main thread, so its deadline fires however long the directory listing and hashing run. */
const { session, env } = workerData as { session: string; env: Record<string, string | undefined> }
parentPort?.postMessage(currentRecords(session, env))
