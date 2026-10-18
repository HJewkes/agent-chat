import { isInteractiveSurface, SURFACE_NAMES, type AgentIdentity, type SurfaceName } from '../protocol.js'
import { loadProfile } from './profiles.js'
import { chooseSurface } from './surface-resolution.js'
import type { TeleportSubject } from './teleport.js'
import { observedModel } from './transcript.js'
import type { AgentProfile } from './types.js'

/** The surface a remote caller that never reported its OS gets, as before CC-951. */
const LEGACY_SURFACE: SurfaceName = 'iterm-tab'

const PLATFORMS: readonly NodeJS.Platform[] = [
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]

/** CC-951: a platform a caller reported over the wire, or undefined when it is not one. */
export const asPlatform = (value: unknown): NodeJS.Platform | undefined =>
  PLATFORMS.find(platform => platform === value)

const isSurfaceName = (value: string): value is SurfaceName =>
  (SURFACE_NAMES as readonly string[]).includes(value)

/**
 * A descendant of an ordinary human-started session, which has no profile to
 * copy: empty `model` and empty `allowedTools` mean INHERIT in `buildLaunchPlan`
 * — the model the session is observably running on, and the permission posture
 * the human's own settings give it. Emitting flags here would not reproduce the
 * session's configuration, it would invent one and call it continuity. Its
 * `surface` is a placeholder; `teleportConfig` chooses the real one.
 */
export const inheritedProfile = (model: string | undefined): AgentProfile => ({
  name: 'inherited',
  description: 'the configuration the predecessor session was already running under',
  model: model ?? '',
  allowedTools: [],
  isolation: 'none',
  surface: LEGACY_SURFACE,
  role: 'coordinator',
  promptPrelude: '',
})

/**
 * Which account this session is on: what it is observably running under now,
 * falling back to what its spawn row recorded (CC-100).
 *
 * Observed first because it is the live fact — a session that came back through a
 * mode switch or a previous teleport is authoritative about its own environment,
 * and a spawn row several generations old is not.
 */
export const accountOf = (subject: TeleportSubject, identity: AgentIdentity): string | undefined =>
  subject.configDir ?? identity.configDir

export interface TeleportConfigInput {
  identity: AgentIdentity
  subject: TeleportSubject
  model?: string | undefined
  /** An explicit surface from the caller: refused, never replaced, when the destination cannot run it. */
  requested?: SurfaceName | undefined
  /** The seat file's surface for the destination machine. */
  seatSurface?: SurfaceName | undefined
  /** The destination's OS; undefined only for a remote caller too old to report it. */
  platform: NodeJS.Platform | undefined
}

export interface TeleportConfig {
  profile: AgentProfile
  surface: SurfaceName
  /** A human can see the predecessor, so it gets a countdown to veto in. */
  visible: boolean
  /** The surface was asked for, so the successor opens fresh rather than in the predecessor's pane. */
  requested: boolean
}

/**
 * The descendant's launch configuration. A spawned agent keeps its recorded
 * profile; an adopted session, which never had a launch plan, gets the harness's
 * defaults plus the model it is observably running on. The surface follows the
 * CC-951 rule for the destination's OS, so a mac-only record never lands a linux
 * host on iTerm.
 */
export function teleportConfig(input: TeleportConfigInput): TeleportConfig | { error: string } {
  const base = baseConfig(input)
  if ('error' in base) return base
  const surface = surfaceFor(input, base.recorded)
  if ('error' in surface) return surface
  return {
    profile: base.profile,
    surface: surface.surface,
    // An adopted session has no record, and it lives in a terminal.
    visible: base.recorded === undefined || isInteractiveSurface(base.recorded),
    requested: input.requested !== undefined,
  }
}

function baseConfig(
  input: TeleportConfigInput,
): { profile: AgentProfile; recorded: SurfaceName | undefined } | { error: string } {
  const { identity, subject, model } = input
  if (identity.origin === 'adopted') {
    // The transcript is under the session's OWN config dir, which for a session
    // on a dedicated account is not the broker's: without it the model could not
    // be observed and every teleport of such a session silently fell back to the
    // harness default (CC-100).
    const observed = observedModel(subject.cwd, identity.sessionId, accountOf(subject, identity))
    return { profile: inheritedProfile(model ?? observed), recorded: undefined }
  }
  const profile = loadProfile(identity.profile)
  if ('error' in profile) return { error: `cannot reload profile "${identity.profile}": ${profile.error}` }
  return {
    profile: model === undefined ? profile : { ...profile, model },
    recorded: isSurfaceName(identity.surface) ? identity.surface : profile.surface,
  }
}

function surfaceFor(
  input: TeleportConfigInput,
  recorded: SurfaceName | undefined,
): { surface: SurfaceName } | { error: string } {
  const { requested, platform } = input
  if (platform === undefined) return { surface: requested ?? recorded ?? LEGACY_SURFACE }
  const choice = chooseSurface({ requested, seatSurface: input.seatSurface, recorded, platform })
  return choice.ok
    ? { surface: choice.surface }
    : { error: `surface "${requested}" refused: ${choice.reason}` }
}
