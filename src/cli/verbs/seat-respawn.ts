import type { RelaunchSeatResult } from '../../agents/seats/run.js'
import { accountRefusal } from '../../agents/seats/seat-account.js'
import type { SeatRelaunchPlan } from '../../agents/seats/seat-target.js'
import type { SeatAgent } from '../../agents/seats/watchdog.js'
import type { BrokerClient } from '../../client/broker-client.js'
import type { ClientMessage, SurfaceName } from '../../protocol.js'
import { sendAsOwner, type Reply } from './seat-broker.js'

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

/**
 * CC-959: the roster the watchdog reads leaves retired rows out, so a relaunch refused after its retire
 * would find no granted profile on the next run. The newest spawned row, retired or not, still has it.
 */
async function withGrant(
  client: BrokerClient,
  seat: string,
  plan: SeatRelaunchPlan,
): Promise<SeatRelaunchPlan> {
  if (plan.target.spawned !== undefined) return plan
  const frame = { t: 'agents' as const, includeRetired: true }
  const all = (await client.request(frame, 'agents_result')) as Reply<'agents_result'>
  const spawned: SeatAgent | undefined = all.agents
    .filter(agent => agent.name === seat && agent.origin !== 'adopted')
    .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]
  return spawned === undefined ? plan : { ...plan, target: { ...plan.target, spawned } }
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
): Promise<{ retired: string[]; failed?: string }> {
  const retired: string[] = []
  for (const agentId of stale) {
    const frame = { t: 'retire' as const, name: seat, agentId }
    const res = (await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>
    if (res.agentId !== agentId) {
      const answered = res.agentId ?? 'the name'
      return { retired, failed: `broker cannot retire ${agentId} by id (it answered for ${answered})` }
    }
    if (!res.ok) return { retired, failed: `retire ${agentId} refused: ${res.reason ?? 'no reason'}` }
    retired.push(agentId)
  }
  return { retired }
}

/** CC-959: nothing launched; the human item names what a retire already took away, to relaunch by hand. */
function refusedAfter(retired: string[], as: LaunchedAs, why: string): RelaunchSeatResult {
  const gone =
    retired.length === 0
      ? ''
      : `; already retired ${retired.join(', ')} (profile ${as.profile}, cwd ${as.cwd})`
  return { ok: false, refused: true, detail: `${why}${gone}` }
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

interface Spawned {
  res: Reply<'spawn_result'>
  how: string
}

async function spawnOn(
  client: BrokerClient,
  seat: string,
  plan: SeatRelaunchPlan,
  surface: SurfaceName,
): Promise<Spawned> {
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

/** CC-465: a visible launch that fails falls back to headless, as the by-name resume does. */
async function spawnSeat(
  client: BrokerClient,
  seat: string,
  plan: SeatRelaunchPlan,
  declared: RespawnSurface,
): Promise<Spawned & RespawnSurface> {
  const visible = await spawnOn(client, seat, plan, declared.surface)
  if (visible.res.ok || declared.surface === 'headless' || !launchFailed(visible.res))
    return { ...visible, ...declared }
  const why = `${declared.surface} refused: ${visible.res.reason ?? 'launch failed'}`
  return { ...(await spawnOn(client, seat, plan, 'headless')), surface: 'headless', from: why }
}

/**
 * CC-959: a dark seat whose latest session the broker cannot resume by name comes back on the
 * seat file's account: stale rows retired by id, then its latest session, else a fresh launch.
 * The retire cannot be undone, so a launch refused after it is raised to the human, not just retried.
 */
export async function respawnSeat(
  client: BrokerClient,
  seat: string,
  given: SeatRelaunchPlan,
  declared: RespawnSurface,
): Promise<RelaunchSeatResult> {
  const plan = await withGrant(client, seat, given)
  const as = launchedAs(plan, true)
  if ('refusal' in as) return { ok: false, refused: true, detail: `not relaunched: ${as.refusal}` }
  const foreign = plan.target.spawned && accountRefusal(plan.account, plan.target.spawned)
  if (foreign) return { ok: false, refused: true, detail: `not relaunched: ${foreign}` }
  const { retired, failed } = await retireStale(client, seat, leaseHolders(plan))
  if (failed !== undefined) return refusedAfter(retired, as, failed)
  const launched = await spawnSeat(client, seat, plan, declared)
  const { res, how, surface, from } = launched
  if (!res.ok) return refusedAfter(retired, as, `spawn refused: ${res.reason ?? 'no reason'}`)
  const note = await resumeNote(client, seat, plan, launched)
  return { ok: true, detail: `relaunched ${how} on ${plan.account.configDir}, ${surface} (${from})${note}` }
}

/**
 * A visible resume launches with no prompt, so its message would be dropped; like the by-name
 * resume, it goes as a send the broker holds until the seat registers. Headless gets it on stdin.
 */
async function resumeNote(
  client: BrokerClient,
  seat: string,
  plan: SeatRelaunchPlan,
  { how, surface }: Spawned & RespawnSurface,
): Promise<string> {
  if (surface === 'headless' || !how.startsWith('session ')) return ''
  const sent = await sendAsOwner(client, seat, plan.message)
  return sent.ok ? `; ${sent.detail}` : `; message not delivered: ${sent.detail}`
}
