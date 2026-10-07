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
