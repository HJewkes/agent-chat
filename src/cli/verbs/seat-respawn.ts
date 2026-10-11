import type { RelaunchSeatResult } from '../../agents/seats/run.js'
import type { SeatRelaunchPlan } from '../../agents/seats/seat-target.js'
import type { BrokerClient } from '../../client/broker-client.js'
import type { ClientMessage, SurfaceName } from '../../protocol.js'
import type { Reply } from './seat-broker.js'

type SpawnFrame = Extract<ClientMessage, { t: 'spawn' }>

/** The surface a relaunched seat comes back on, and where that was read from. */
export interface RespawnSurface {
  surface: SurfaceName
  from: string
}

/** CC-465: the same rule as the by-name resume; a visible launch that fails falls back to headless. */
const launchFailed = (res: Reply<'spawn_result'>): boolean => res.code === 'surface_refused'

/** What the seat launches as: only what the broker granted it before, never what the seat file says. */
interface LaunchedAs {
  profile: string
  cwd: string
}

/**
 * CC-959: the watchdog's connection is unregistered, so the broker treats its spawn as the human's and
 * skips the escalation and cwd rules. The seat file must therefore pick neither: the profile is the
 * one the broker last launched the seat with, and the cwd is the row's own. Fails closed.
 */
function launchedAs({ target }: SeatRelaunchPlan, session: boolean): LaunchedAs | { refusal: string } {
  const { spawned } = target
  if (spawned === undefined || spawned.profile === '')
    return { refusal: 'no spawned row under the seat name to take its granted profile from' }
  const own = session && target.kind === 'resume-session' ? target.cwd : spawned.cwd
  if (own === undefined) return { refusal: `row ${spawned.agentId ?? spawned.name} recorded no cwd` }
  return { profile: spawned.profile, cwd: own }
}

/** The broker refuses a session whose transcript is not under the seat's account and cwd. */
const sessionRefused = (res: Reply<'spawn_result'>): boolean => /resume_session/.test(res.reason ?? '')

/** CC-959: every unretired spawned row leases the name, the latest too when it ran on another account. */
function leaseHolders({ target }: SeatRelaunchPlan): string[] {
  const { latest } = target
  if (target.kind !== 'fresh' || latest.origin === 'adopted' || latest.agentId === undefined)
    return target.stale
  return [...target.stale, latest.agentId]
}

/**
 * CC-959: each row that leases the seat's name is retired by id, never by name.
 * A broker that predates `agentId` retires by name and echoes no id; that is unsafe, so nothing launches.
 */
async function retireStale(
  client: BrokerClient,
  seat: string,
  stale: string[],
): Promise<RelaunchSeatResult | undefined> {
  for (const agentId of stale) {
    const frame = { t: 'retire' as const, name: seat, agentId }
    const res = (await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>
    if (res.agentId !== agentId)
      return {
        ok: false,
        unsupported: true,
        detail: `broker cannot retire ${agentId} by id (it answered for ${res.agentId ?? 'the name'})`,
      }
    if (!res.ok) return { ok: false, detail: `retire ${agentId} refused: ${res.reason ?? 'no reason'}` }
  }
  return undefined
}

function spawnFrame(
  seat: string,
  plan: SeatRelaunchPlan,
  surface: SurfaceName,
  { session, as }: { session: boolean; as: LaunchedAs },
): SpawnFrame {
  const { account, target } = plan
  const resumed = session && target.kind === 'resume-session' ? target : undefined
  return {
    t: 'spawn',
    name: seat,
    profile: as.profile,
    brief: resumed === undefined ? plan.fresh : plan.message,
    isolation: 'none',
    surface,
    configDir: account.configDir,
    returnContract: 'none',
    cwd: as.cwd,
    ...(resumed === undefined ? {} : { resumeSession: resumed.sessionId }),
    // CC-883: a seat runs with Remote Control; a headless launch has no pane to control.
    ...(surface === 'headless' ? {} : { remoteControl: true }),
  }
}

async function spawnOn(
  client: BrokerClient,
  seat: string,
  plan: SeatRelaunchPlan,
  surface: SurfaceName,
): Promise<{ res: Reply<'spawn_result'>; how: string }> {
  const request = async (session: boolean): Promise<Reply<'spawn_result'>> => {
    const as = launchedAs(plan, session)
    if ('refusal' in as) return { t: 'spawn_result', ok: false, reason: as.refusal }
    const frame = spawnFrame(seat, plan, surface, { session, as })
    return (await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>
  }
  if (plan.target.kind !== 'resume-session') return { res: await request(false), how: 'fresh' }
  const resumed = await request(true)
  if (resumed.ok || !sessionRefused(resumed)) return { res: resumed, how: `session ${plan.target.sessionId}` }
  return { res: await request(false), how: `fresh (${resumed.reason ?? 'session refused'})` }
}

/**
 * CC-959: a dark seat whose latest session the broker cannot resume by name comes back on the
 * seat file's account: stale rows retired by id, then its latest session, else a fresh launch.
 */
export async function respawnSeat(
  client: BrokerClient,
  seat: string,
  plan: SeatRelaunchPlan,
  declared: RespawnSurface,
): Promise<RelaunchSeatResult> {
  const launch = launchedAs(plan, true)
  if ('refusal' in launch) return { ok: false, detail: `not relaunched: ${launch.refusal}` }
  const retired = await retireStale(client, seat, leaseHolders(plan))
  if (retired !== undefined) return retired
  let { surface, from: why } = declared
  let spawned = await spawnOn(client, seat, plan, surface)
  if (!spawned.res.ok && surface !== 'headless' && launchFailed(spawned.res)) {
    why = `${surface} refused: ${spawned.res.reason ?? 'launch failed'}`
    surface = 'headless'
    spawned = await spawnOn(client, seat, plan, surface)
  }
  const { res, how } = spawned
  return res.ok
    ? { ok: true, detail: `relaunched ${how} on ${plan.account.configDir}, ${surface} (${why})` }
    : { ok: false, detail: `spawn refused: ${res.reason ?? 'no reason'}` }
}
