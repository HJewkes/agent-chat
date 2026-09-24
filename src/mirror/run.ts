import fs from 'node:fs'
import { AppserviceClient } from '@titan-design/matrix-bus'
import {
  runMirror,
  type MirrorBus,
  type MirrorLogger,
  type MirrorOptions,
  type MirrorState,
  type QueueSource,
} from '@titan-design/queue-mirror'
import { readMeta } from '../broker/lifecycle.js'
import { readToken } from '../broker/token.js'
import { BrokerClient } from '../client/broker-client.js'
import { mirrorStatePath, mirrorStatusPath, tokenPath } from '../paths.js'
import { loadMirrorConfig, readAsToken, type MirrorConfig } from './config.js'
import { agentChatQueueSource, type VerdictChannel } from './source.js'
import { STATUS_INTERVAL_MS, StatusTracker, trackBus, trackSource, writeStatus } from './status.js'

/** Test seams only; production passes none of these. */
export type MirrorTuning = Pick<
  MirrorOptions,
  'now' | 'sweepIntervalMs' | 'syncTimeoutMs' | 'backoff' | 'sleep'
>

export interface MirrorLoopInput {
  source: QueueSource
  bus: MirrorBus
  state: MirrorState
  ownerUserId: string
  roomId: string
  signal: AbortSignal
  logger: MirrorLogger
  tuning?: MirrorTuning
}

/**
 * No `approvalTtlMs`, deliberately: the adapter stamps `expiresAt` on relayed
 * approvals, and CC-144 hook approvals carry none because they never age out.
 */
export function runMirrorLoop(input: MirrorLoopInput): Promise<void> {
  const { source, bus, state, ownerUserId, roomId, signal, logger, tuning } = input
  return runMirror(source, bus, state, { ...tuning, ownerUserId, roomId, signal, logger })
}

/** JSON lines on stdout, which launchd routes to the log; warnings also land in the status file. */
export function jsonLogger(
  tracker: StatusTracker,
  write = (line: string) => process.stdout.write(line),
): MirrorLogger {
  const emit = (level: string, msg: string, data?: object) =>
    write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })}\n`)
  return {
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => {
      const detail = (data as { error?: unknown } | undefined)?.error
      tracker.noteError(typeof detail === 'string' ? `${msg}: ${detail}` : msg)
      emit('warn', msg, data)
    },
  }
}

/** `BrokerClient.request` refuses before `connect`; the mirror connects on its first verdict instead. */
export function lazyVerdicts(client: BrokerClient): VerdictChannel {
  return {
    async request(message, replyType) {
      await client.connect()
      return client.request(message, replyType)
    },
  }
}

/** Never `autoStart`: a launchd-kept mirror must not resurrect a broker someone stopped. */
export const unregisteredClient = (): BrokerClient =>
  new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, { autoStart: false })

function brokerBaseUrl(): string | null {
  const port = readMeta()?.port
  return typeof port === 'number' ? `http://127.0.0.1:${port}` : null
}

export function brokerSource(machine: string, verdicts: VerdictChannel): QueueSource {
  return agentChatQueueSource({
    machine,
    baseUrl: brokerBaseUrl,
    token: () => readToken(tokenPath()),
    verdicts,
  })
}

export interface OpenedState {
  state: MirrorState
  close(): void
}

/** Dynamic imports keep better-sqlite3 out of every process except `mirror run`. */
export async function openMirrorState(file = mirrorStatePath()): Promise<OpenedState> {
  const { openDatabase } = await import('@titan-design/store-sqlite')
  const { SqliteMirrorState } = await import('@titan-design/queue-mirror/sqlite')
  const db = openDatabase(file)
  fs.chmodSync(file, 0o600)
  return { state: new SqliteMirrorState(db, { migrate: true }), close: () => db.close() }
}

export function matrixClient(config: MirrorConfig, asToken: string): AppserviceClient {
  return new AppserviceClient({
    baseUrl: config.homeserverUrl,
    asToken,
    userId: config.mirrorUserId,
    sender: config.mirrorUserId,
  })
}

/** Rewrites the status file now and every `STATUS_INTERVAL_MS`; the returned stop writes a last one. */
export function startStatusWriter(tracker: StatusTracker, open: () => number, file = mirrorStatusPath()) {
  const write = () => writeStatus(file, tracker.snapshot(open()))
  write()
  const timer = setInterval(write, STATUS_INTERVAL_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    write()
  }
}

/** The error names the room and homeserver, since it is what `doctor` shows when the mirror is down. */
async function joinQueueRoom(bus: AppserviceClient, config: MirrorConfig): Promise<string> {
  try {
    return (await bus.joinRoom(config.roomAlias)).room_id
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`joining ${config.roomAlias} on ${config.homeserverUrl} failed: ${reason}`)
  }
}

/** What launchd runs. A startup failure is written to the status file before it propagates. */
export async function runMirrorDaemon(signal: AbortSignal): Promise<void> {
  const tracker = new StatusTracker()
  const logger = jsonLogger(tracker)
  let openCount = () => 0
  const stopStatus = startStatusWriter(tracker, () => openCount())
  const client = unregisteredClient()
  try {
    const config = loadMirrorConfig()
    const bus = matrixClient(config, readAsToken())
    const roomId = await joinQueueRoom(bus, config)
    const opened = await openMirrorState()
    openCount = () => opened.state.openItems().length
    logger.info('started', { roomId, machine: config.machine, pid: process.pid })
    const source = trackSource(brokerSource(config.machine, lazyVerdicts(client)), tracker)
    await runMirrorLoop({
      source,
      bus: trackBus(bus, tracker),
      state: opened.state,
      ownerUserId: config.ownerUserId,
      roomId,
      signal,
      logger,
    }).finally(opened.close)
  } catch (err) {
    tracker.noteError(err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    client.close()
    stopStatus()
  }
}
