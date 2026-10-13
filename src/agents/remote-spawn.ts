import path from 'node:path'
import type { IsolationName, SurfaceName } from '../protocol.js'
import { resolveDestination, type ConnectedLauncher, type DestinationResult } from './teleport-destination.js'
import { chooseSurface, defaultSpawnSurface, type SpawnSurfaceInput } from './surface-resolution.js'

/**
 * CC-1059: a spawn whose requester runs on another host from the broker. The broker records the
 * identity and hands back a host-neutral launch; the requester's own process checks, writes and
 * opens it there, reporting `ready` before it opens anything and `placed` after. Until the agent
 * registers, the record here is the only thing that can retire it, so every path out of it that
 * is not an attach retires the identity and frees its slot.
 */

/** How long the broker waits for the requester's ready report before it retires the identity. */
export const REPORT_WINDOW_MS = 60_000

/** Isolations that confine tools only, so they run the same on any host. */
const HOST_NEUTRAL_ISOLATION: readonly IsolationName[] = ['none', 'toolset-limited']

export type SpawnSite =
  { site: 'broker' } | { site: 'caller'; host: string; platform: NodeJS.Platform } | { refusal: string }

export interface SiteInput {
  /** The machine asked for, an alias or a hostname. */
  host?: string | undefined
  callerHost?: string | undefined
  hostPlatform?: NodeJS.Platform | undefined
  launchesHere?: true | undefined
  brokerHost: string
  launchers: readonly ConnectedLauncher[]
  aliases: Readonly<Record<string, string>>
}

/**
 * Where a spawn launches. A requester that cannot launch on its own host (an older client) and
 * names no host keeps today's broker launch exactly; otherwise the destination rule teleport uses.
 */
export function spawnSiteFor(input: SiteInput): SpawnSite {
  if (input.host === undefined && input.launchesHere !== true) return { site: 'broker' }
  const callerHost = input.callerHost ?? input.brokerHost
  const resolved: DestinationResult = resolveDestination({
    to: input.host,
    callerHost,
    brokerHost: input.brokerHost,
    launchers: input.launchers,
    aliases: input.aliases,
  })
  if (!resolved.ok) return { refusal: resolved.reason }
  const { site, host } = resolved.destination
  if (site === 'broker') return { site: 'broker' }
  if (site === 'launcher')
    return {
      refusal:
        `spawning through the host launcher on ${host} is not supported yet; spawn from a session on ` +
        `${host}, or name host ${input.brokerHost} to launch on the broker's host`,
    }
  if (input.launchesHere !== true)
    return {
      refusal: `agent-chat on ${callerHost} predates launching a spawn on its own host; update it there`,
    }
  if (input.hostPlatform === undefined)
    return {
      refusal: `the requester on ${callerHost} did not say which OS it runs, so no surface can be chosen`,
    }
  return { site: 'caller', host, platform: input.hostPlatform }
}

export interface RemoteScopeInput {
  isolation: IsolationName
  worktree?: string | undefined
  owns?: readonly string[] | undefined
  claimPaths?: readonly string[] | undefined
  inherit?: 'context' | undefined
  resumeSession?: string | undefined
}

/** v1 launches only what needs nothing from the launching host's git or transcripts. */
export function remoteScopeRefusal(
  req: RemoteScopeInput,
  host: string,
  brokerHost: string,
): string | undefined {
  const needs = remoteNeed(req)
  if (needs === undefined) return undefined
  return (
    `${needs} cannot be set up on ${host} by a spawn launched there yet; name host ${brokerHost} ` +
    "to launch it on the broker's host"
  )
}

function remoteNeed(req: RemoteScopeInput): string | undefined {
  if (req.worktree) return 'an assigned worktree'
  if (req.owns?.length) return 'owns (file-ownership isolation)'
  if (req.claimPaths?.length) return 'claim_paths'
  if (req.inherit === 'context') return 'inherit: context'
  if (req.resumeSession !== undefined) return 'resume_session'
  if (!HOST_NEUTRAL_ISOLATION.includes(req.isolation)) return `${req.isolation} isolation`
  return undefined
}

/**
 * The surface on the launching host's OS: an explicit request is refused there rather than
 * replaced, and the spawn's own default (a seat worker's headless, else the profile's) stands
 * only when that host can run it.
 */
export function remoteSurface(
  input: Omit<SpawnSurfaceInput, 'requested'> & { requested?: SurfaceName | undefined },
  platform: NodeJS.Platform,
  host: string,
): { surface: SurfaceName } | { refusal: string } {
  const fallback = defaultSpawnSurface({ ...input, requested: undefined })
  const choice = chooseSurface({ requested: input.requested, seatSurface: fallback, platform })
  if (choice.ok) return { surface: choice.surface }
  return { refusal: `${choice.reason.replace('this host', host)}; use surface 'headless'` }
}

/**
 * The home the lexical cwd check holds a cwd under, on the requester's host. Named by the
 * requester when it can; otherwise its OS's convention for this user, since the broker's own home
 * (`/home/...`) would refuse every macOS path.
 */
export function callerHomeFor(platform: NodeJS.Platform, user: string, named?: string): string {
  if (named !== undefined && path.isAbsolute(named)) return path.resolve(named)
  return platform === 'darwin' ? `/Users/${user}` : `/home/${user}`
}

export interface RemoteSpawnRecord {
  agentId: string
  name: string
  host: string
  /** Runs once, when the agent registers: the hooks, journal and dispatch row a local spawn writes. */
  announce: () => void
}

export interface RemoteSpawnDeps {
  reportMs: number
  /** How long `placed` holds its reply for the registration before answering pending. */
  attachMs: number
  /** From the ack on: no registration by then retires the identity. */
  ceilingMs: number
  /** Retires the identity and releases its slot. */
  retire: (record: RemoteSpawnRecord, reason: string) => void
}

export interface ReportReply {
  ok: boolean
  reason?: string
}

export type PlacedVerdict = { kind: 'attached' } | { kind: 'pending' } | { kind: 'failed'; reason: string }

interface Pending {
  record: RemoteSpawnRecord
  phase: 'launching' | 'acked' | 'placed' | 'attached'
  timer?: NodeJS.Timeout
  waiter?: (verdict: PlacedVerdict) => void
}

const span = (ms: number): string =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`

/** The pending remote spawns, keyed by agent id, with the timers that retire a lost one. */
export class RemoteSpawns {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: RemoteSpawnDeps) {}

  open(record: RemoteSpawnRecord): void {
    const entry: Pending = { record, phase: 'launching' }
    this.pending.set(record.agentId, entry)
    this.arm(
      entry,
      this.deps.reportMs,
      `no ready report from ${record.host} within ${span(this.deps.reportMs)}`,
    )
  }

  has(agentId: string): boolean {
    const entry = this.pending.get(agentId)
    return entry !== undefined && entry.phase !== 'attached'
  }

  /** The requester checked and wrote the launch on its host; an ok reply lets it open the surface. */
  ready(agentId: string, report: ReportReply): ReportReply {
    const entry = this.pending.get(agentId)
    if (entry?.phase !== 'launching') return { ok: false, reason: notWaiting(agentId, 'a ready report') }
    if (!report.ok) {
      const reason = `refused on ${entry.record.host}: ${report.reason ?? 'no reason given'}`
      this.fail(entry, reason)
      return { ok: false, reason }
    }
    entry.phase = 'acked'
    const unconfirmed = `placement unconfirmed: ${entry.record.name} did not register within ${span(this.deps.ceilingMs)}`
    this.arm(entry, this.deps.ceilingMs, `${unconfirmed} on ${entry.record.host}`)
    return { ok: true }
  }

  /** The requester opened the surface, or failed to; answers once the agent registers or `attachMs` passes. */
  placed(agentId: string, report: ReportReply): Promise<PlacedVerdict> {
    const entry = this.pending.get(agentId)
    if (entry?.phase === 'attached') {
      this.forget(entry)
      return Promise.resolve({ kind: 'attached' })
    }
    if (entry?.phase !== 'acked')
      return Promise.resolve({ kind: 'failed', reason: notWaiting(agentId, 'a placed report') })
    if (!report.ok) {
      const reason = `not placed on ${entry.record.host}: ${report.reason ?? 'no reason given'}`
      this.fail(entry, reason)
      return Promise.resolve({ kind: 'failed', reason })
    }
    entry.phase = 'placed'
    return new Promise(resolve => {
      const wait = setTimeout(() => settle({ kind: 'pending' }), this.deps.attachMs)
      wait.unref?.()
      const settle = (verdict: PlacedVerdict): void => {
        clearTimeout(wait)
        delete entry.waiter
        resolve(verdict)
      }
      entry.waiter = settle
    })
  }

  /** The agent registered; an attach before `placed` arrives is kept for that report to read. */
  attached(agentId: string): void {
    const entry = this.pending.get(agentId)
    if (entry === undefined || entry.phase === 'attached') return
    clearTimeout(entry.timer)
    const reported = entry.phase === 'placed'
    entry.phase = 'attached'
    entry.record.announce()
    entry.waiter?.({ kind: 'attached' })
    if (reported) return this.forget(entry)
    // Held only so a late `placed` reads the attach; nothing is retired when this lapses.
    this.arm(entry, this.deps.ceilingMs, undefined)
  }

  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }

  private arm(entry: Pending, ms: number, failure: string | undefined): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(
      () => (failure === undefined ? this.forget(entry) : this.fail(entry, failure)),
      ms,
    )
    entry.timer.unref?.()
  }

  private fail(entry: Pending, reason: string): void {
    this.forget(entry)
    entry.waiter?.({ kind: 'failed', reason })
    this.deps.retire(entry.record, reason)
  }

  private forget(entry: Pending): void {
    clearTimeout(entry.timer)
    this.pending.delete(entry.record.agentId)
  }
}

const notWaiting = (agentId: string, what: string): string =>
  `no spawn of ${agentId} is waiting for ${what}; it was retired, already reported or never recorded`
