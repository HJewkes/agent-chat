import fs from 'node:fs'
import path from 'node:path'
import type { MirrorBus, QueueSource } from '@titan-design/queue-mirror'
import type { Check } from '../broker/doctor.js'
import { isProcessAlive } from '../broker/lifecycle.js'
import { mirrorConfigPath, mirrorEnvPath, mirrorPlistPath, mirrorStatusPath } from '../paths.js'
import { AS_TOKEN_KEY, fileMode, formatMode, isPrivateMode, loadMirrorConfig, readAsToken } from './config.js'

/** What a running mirror writes to `mirror.status.json` every few seconds. */
export interface MirrorStatus {
  pid: number
  startedAt: number
  /** Epoch ms of the last written snapshot; freshness is measured from this. */
  writtenAt: number
  lastSyncAt: number | null
  lastSourceEventAt: number | null
  open: number
  lastError: string | null
}

export const STATUS_INTERVAL_MS = 5_000

/** Six missed rewrites: long enough to ride out a GC pause, short enough to catch a wedged loop. */
export const STATUS_STALE_MS = 30_000

/** Mutable counters the wrapped source, bus and logger feed; `snapshot` freezes them for the file. */
export class StatusTracker {
  private lastSyncAt: number | null = null
  private lastSourceEventAt: number | null = null
  private lastError: string | null = null
  readonly startedAt: number

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now()
  }

  noteSync(): void {
    this.lastSyncAt = this.now()
  }

  noteSourceEvent(): void {
    this.lastSourceEventAt = this.now()
  }

  noteError(message: string): void {
    this.lastError = message
  }

  snapshot(open: number): MirrorStatus {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      writtenAt: this.now(),
      lastSyncAt: this.lastSyncAt,
      lastSourceEventAt: this.lastSourceEventAt,
      open,
      lastError: this.lastError,
    }
  }
}

/** The same source, with every tailed event stamped on `tracker`. */
export function trackSource(source: QueueSource, tracker: StatusTracker): QueueSource {
  return {
    kinds: source.kinds,
    open: () => source.open(),
    resolve: (id, verdict) => source.resolve(id, verdict),
    tail(cursor, signal) {
      const inner = source.tail(cursor, signal)[Symbol.asyncIterator]()
      return {
        [Symbol.asyncIterator]: () => ({
          async next() {
            const result = await inner.next()
            if (!result.done) tracker.noteSourceEvent()
            return result
          },
          return: async () => (await inner.return?.()) ?? { done: true, value: undefined },
        }),
      }
    },
  }
}

/** The same bus, with every /sync batch stamped on `tracker`. */
export function trackBus(bus: MirrorBus, tracker: StatusTracker): MirrorBus {
  return {
    userId: bus.userId,
    send: (roomId, type, content, txnId) => bus.send(roomId, type, content, txnId),
    async *syncLoop(options) {
      for await (const batch of bus.syncLoop(options)) {
        tracker.noteSync()
        yield batch
      }
    },
  }
}

/** Written to a temp file and renamed, so a reader never sees half a snapshot. */
export function writeStatus(file: string, status: MirrorStatus): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(status)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

export function readStatus(file: string): MirrorStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MirrorStatus>
    if (typeof parsed.pid !== 'number' || typeof parsed.writtenAt !== 'number') return null
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt ?? parsed.writtenAt,
      writtenAt: parsed.writtenAt,
      lastSyncAt: parsed.lastSyncAt ?? null,
      lastSourceEventAt: parsed.lastSourceEventAt ?? null,
      open: parsed.open ?? 0,
      lastError: parsed.lastError ?? null,
    }
  } catch {
    return null
  }
}

/** Everything `describeMirror` needs, read from disk by the caller so this stays pure. */
export interface MirrorFacts {
  configPresent: boolean
  configPath: string
  envMode: number | null
  plistLeaksToken: boolean
  status: MirrorStatus | null
  pidAlive: boolean
  roomAlias: string | null
  now: number
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 120) return `${seconds}s`
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

const check = (status: Check['status'], detail: string): Check => ({ name: 'mirror', status, detail })

/** The doctor line. Only a leak is a fault; not configured and not running are states. */
export function describeMirror(facts: MirrorFacts): Check {
  if (!facts.configPresent) return check('warn', `not configured (${facts.configPath} absent)`)
  if (facts.envMode !== null && !isPrivateMode(facts.envMode)) {
    return check('fail', `mirror.env is ${formatMode(facts.envMode)}; must be 0600`)
  }
  if (facts.plistLeaksToken) return check('fail', 'the launchd plist contains the appservice token')
  if (facts.envMode === null) return check('warn', 'configured, but mirror.env is absent')
  return describeRunning(facts)
}

function describeRunning(facts: MirrorFacts): Check {
  const { status } = facts
  const error = status?.lastError ? ` (last error: ${status.lastError})` : ''
  if (status === null || !facts.pidAlive) return check('warn', `configured but not running${error}`)
  const age = facts.now - status.writtenAt
  if (age > STATUS_STALE_MS) return check('warn', `status ${formatAge(age)} stale${error}`)
  const synced =
    status.lastSyncAt === null ? 'not synced yet' : `synced ${formatAge(facts.now - status.lastSyncAt)} ago`
  const room = facts.roomAlias ?? '#queue'
  return check('ok', `running pid ${status.pid}, ${synced}, ${status.open} open on ${room}${error}`)
}

export interface MirrorFiles {
  config: string
  env: string
  plist: string
  status: string
}

export const defaultMirrorFiles = (): MirrorFiles => ({
  config: mirrorConfigPath(),
  env: mirrorEnvPath(),
  plist: mirrorPlistPath(),
  status: mirrorStatusPath(),
})

/** Synapse access tokens start `syt_`; the key name or the live token value count as well. */
export function plistLeaksToken(plist: string, token: string | null): boolean {
  return plist.includes(AS_TOKEN_KEY) || plist.includes('syt_') || (token !== null && plist.includes(token))
}

function readPlistLeak(files: MirrorFiles): boolean {
  let plist: string
  try {
    plist = fs.readFileSync(files.plist, 'utf8')
  } catch {
    return false
  }
  let token: string | null = null
  try {
    token = readAsToken(files.env)
  } catch {
    // An unreadable or loose env file is reported on its own line; the key and prefix checks still run.
  }
  return plistLeaksToken(plist, token)
}

function readRoomAlias(file: string): string | null {
  try {
    return loadMirrorConfig(file).roomAlias
  } catch {
    return null
  }
}

/** Files only: no Matrix call and no broker connection, so `doctor` stays offline and cheap. */
export function readMirrorFacts(files = defaultMirrorFiles(), now = Date.now()): MirrorFacts {
  const status = readStatus(files.status)
  return {
    configPresent: fs.existsSync(files.config),
    configPath: files.config,
    envMode: fileMode(files.env),
    plistLeaksToken: readPlistLeak(files),
    status,
    pidAlive: status !== null && isProcessAlive(status.pid),
    roomAlias: readRoomAlias(files.config),
    now,
  }
}
