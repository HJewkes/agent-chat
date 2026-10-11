import type { SurfaceName } from '../protocol.js'
import { resolveTmuxOnLinux } from '../config.js'

const ITERM_SURFACES: readonly SurfaceName[] = ['iterm-pane', 'iterm-tab', 'iterm-window']

/**
 * CC-804: a Linux host has no iTerm2, so with `tmuxSurfaceOnLinux` set in `config.json` every
 * iTerm surface a profile, request or seat file names lands in a tmux window instead. Headless
 * stays headless, and a host that has not opted in resolves every name to itself.
 */
export function resolveSurface(
  name: SurfaceName,
  platform: NodeJS.Platform = process.platform,
  tmuxOnLinux: boolean = resolveTmuxOnLinux(),
): SurfaceName {
  return platform === 'linux' && tmuxOnLinux && ITERM_SURFACES.includes(name) ? 'tmux-window' : name
}

/** CC-951: why `surface` cannot run on a host of `platform`; undefined when it can. */
export function surfaceBlockerFor(surface: SurfaceName, platform: NodeJS.Platform): string | undefined {
  if (ITERM_SURFACES.includes(surface) && platform !== 'darwin')
    return `iTerm2 surfaces need macOS (this host is ${platform})`
  if (surface === 'tmux-window' && platform === 'win32')
    return `tmux windows need a unix host (this host is ${platform})`
  return undefined
}

/** CC-951: the surface a host's OS runs a seat in when nothing names a runnable one. */
export function platformDefaultSurface(platform: NodeJS.Platform): SurfaceName {
  if (platform === 'darwin') return 'iterm-tab'
  return platform === 'linux' ? 'tmux-window' : 'headless'
}

export interface SurfaceChoiceInput {
  /** An explicit request; refused rather than replaced when the host cannot run it. */
  requested?: SurfaceName | undefined
  /** The seat file's entry for the destination machine (`seatSurfaceFor`). */
  seatSurface?: SurfaceName | undefined
  /** The surface the session last ran in. */
  recorded?: SurfaceName | undefined
  platform: NodeJS.Platform
}

export type SurfaceChoice =
  | { ok: true; surface: SurfaceName; from: 'requested' | 'seat' | 'recorded' | 'platform' }
  | { ok: false; reason: string }

/**
 * CC-951: the one rule teleport and the watchdog resume share. An explicit request wins or is
 * refused; otherwise the seat's entry, then the recorded surface, each only when the host can run
 * it, then the host OS's default. A mac-only seat surface never lands a linux host on iTerm.
 */
export function chooseSurface(input: SurfaceChoiceInput): SurfaceChoice {
  const { requested, platform } = input
  if (requested !== undefined) {
    const reason = surfaceBlockerFor(requested, platform)
    return reason === undefined ? { ok: true, surface: requested, from: 'requested' } : { ok: false, reason }
  }
  const candidates = [
    { surface: input.seatSurface, from: 'seat' },
    { surface: input.recorded, from: 'recorded' },
  ] as const
  for (const { surface, from } of candidates) {
    if (surface !== undefined && surfaceBlockerFor(surface, platform) === undefined)
      return { ok: true, surface, from }
  }
  return { ok: true, surface: platformDefaultSurface(platform), from: 'platform' }
}
