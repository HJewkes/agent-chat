import type { AgentIdentity, HostProbe, RemoteLaunch, SurfaceName } from '../protocol.js'
import { PEER_PREAMBLE } from './launch-plan.js'
import { callerHomeFor } from './remote-spawn.js'
import { RESUMED_BRIEF, type TranscriptVerdict } from './resume-session.js'
import type { LauncherAnswer } from './teleport.js'
import { remotePathBlocker, resolveDestination, type ConnectedLauncher } from './teleport-destination.js'
import type { AgentProfile } from './types.js'

/**
 * CC-1472: `agent_resume host:<name>` resumes an agent on the machine its transcript is on, through
 * that machine's host launcher. The broker can read neither that disk nor that account, so it
 * routes, checks what it can lexically, and leaves the transcript to the launcher's probe.
 */

/**
 * The launcher's 45s launch budget plus slack. With the 10s probe ahead of it, the broker still
 * answers inside the client's 60s `spawn_result` ceiling.
 */
export const HOST_RESUME_TIMEOUT_MS = 48_000

/** Isolations that confine tools only, so they resume the same on any host. */
const HOST_NEUTRAL_ISOLATION = ['', 'none', 'toolset-limited']

export type ResumeRoute =
  { site: 'broker' } | { site: 'launcher'; host: string; platform: NodeJS.Platform } | { refusal: string }

export type LauncherRoute = Extract<ResumeRoute, { site: 'launcher' }>

export interface ResumeRouteInput {
  host: string
  brokerHost: string
  launchers: readonly ConnectedLauncher[]
  aliases: Readonly<Record<string, string>>
}

/** Where a host resume runs. The requester's own host plays no part: the transcript decides. */
export function resumeRouteFor(input: ResumeRouteInput): ResumeRoute {
  const resolved = resolveDestination({
    to: input.host,
    callerHost: input.brokerHost,
    brokerHost: input.brokerHost,
    launchers: input.launchers,
    aliases: input.aliases,
  })
  if (!resolved.ok) return { refusal: resolved.reason }
  const { site, host, platform } = resolved.destination
  if (site === 'launcher' && platform !== undefined) return { site: 'launcher', host, platform }
  return { site: 'broker' }
}

export interface RemoteResumeSite {
  host: string
  platform: NodeJS.Platform
  brokerHost: string
  brokerPlatform: NodeJS.Platform
  /** The broker's own user and home, from which the launcher's home is inferred. */
  user: string
  brokerHome: string
  /** The surfaces the launcher announced. */
  surfaces: readonly SurfaceName[]
}

/** The home a path on the launcher's machine must sit under: a Mac's `/Users/...` is not a Linux broker's home. */
export const launcherHome = (site: RemoteResumeSite): string =>
  site.platform === site.brokerPlatform ? site.brokerHome : callerHomeFor(site.platform, site.user)

/** Why `agent` cannot resume on the launcher's machine, from what the broker knows without its disk. */
export function remoteResumeRefusal(
  agent: AgentIdentity,
  surface: SurfaceName,
  site: RemoteResumeSite,
): string | undefined {
  const { name } = agent
  if (!HOST_NEUTRAL_ISOLATION.includes(agent.isolation))
    return `${name} has ${agent.isolation} isolation, which is local to ${site.brokerHost}, so it cannot resume on ${site.host}`
  if (agent.configDir === undefined && agent.configDirUnset !== true)
    return (
      `${name} records no account, so the account on ${site.host} cannot be chosen; ` +
      'spawn with resume_session and config_dir instead'
    )
  if (!site.surfaces.includes(surface)) return `the launcher on ${site.host} cannot open a ${surface} surface`
  const home = launcherHome(site)
  const blocked =
    remotePathBlocker('working directory', agent.cwd, home) ??
    (agent.configDir === undefined ? undefined : remotePathBlocker('config dir', agent.configDir, home))
  return blocked === undefined ? undefined : `${name} cannot resume on ${site.host}: ${blocked}`
}

export type TranscriptProbe = (host: string, probe: HostProbe) => Promise<LauncherAnswer>

export type ProbedTranscript =
  { transcript: TranscriptVerdict } | { refusal: string; verdict: { transcript?: TranscriptVerdict } }

/** The launcher's own verdict on the transcript. An ok with no verdict is from a launcher too old to have looked. */
export async function probeTranscript(
  probe: TranscriptProbe,
  agent: AgentIdentity,
  surface: SurfaceName,
  host: string,
): Promise<ProbedTranscript> {
  const answer = await probe(host, {
    cwd: agent.cwd,
    surface,
    ...(agent.configDir === undefined ? {} : { configDir: agent.configDir }),
    resumeSession: agent.sessionId,
  })
  const verdict = answer.transcript === undefined ? {} : { transcript: answer.transcript }
  if (!answer.ok) return { refusal: answer.reason ?? `the launcher on ${host} refused`, verdict }
  if (answer.transcript?.found !== true)
    return {
      refusal:
        `the launcher on ${host} predates resuming a session, so it did not check the transcript; ` +
        'update agent-chat there and restart its launcher',
      verdict,
    }
  return { transcript: answer.transcript }
}

/** R1: the caller's host wins, but a second copy here is named, since the two now diverge. */
export function localCopyWarning(local: TranscriptVerdict, brokerHost: string, host: string): string[] {
  if (!local.found) return []
  return [
    `a transcript for this session also exists on ${brokerHost} at ${local.path}; resumed the one on ${host}, ` +
      'so the two copies diverge from here',
  ]
}

export interface ResumeLaunchInput {
  surface: SurfaceName
  message?: string | undefined
  remoteControl?: boolean | undefined
}

/** The same identity on the same session, continued with `--resume`; never the requester's pane. */
export function resumeLaunchFor(
  agent: AgentIdentity,
  profile: AgentProfile,
  req: ResumeLaunchInput,
): RemoteLaunch {
  const { env: _env, mcpServers: _servers, warnings: _warnings, ...remoteProfile } = profile
  return {
    agentId: agent.agentId,
    sessionId: agent.sessionId,
    name: agent.name,
    profile: remoteProfile,
    brief: req.message ?? RESUMED_BRIEF,
    preamble: PEER_PREAMBLE,
    ...(agent.origin === 'adopted' ? { adopted: true as const } : {}),
    surface: req.surface,
    ...(req.remoteControl ? { remoteControl: true } : {}),
    cwd: agent.cwd,
    ...(agent.configDir === undefined ? { configDirUnset: true as const } : { configDir: agent.configDir }),
    resume: true,
  }
}
