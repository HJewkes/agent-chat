import type { SurfaceName } from '../../protocol.js'
import type { Surface } from '../types.js'
import { headlessSurface } from './headless.js'
import { itermSurface, type ItermSurfaceName } from './iterm.js'
import type { SurfaceOptions } from './options.js'

/**
 * Where a spawned agent is presented, and the only place that knows what a pane
 * is. Nothing outside this directory names iTerm — a `tmux-pane` surface is a
 * drop-in here and invisible everywhere else.
 *
 * Surfaces are built per launch rather than kept as singletons because the anchor
 * is presence data: it belongs to the requesting connection, and reusing one
 * surface across requests would mean one requester's spawn landing in another's
 * window.
 */

export type { AppleScriptRunner, SpawnFn, SurfaceOptions } from './options.js'
export { SurfaceRefused } from './options.js'

const isIterm = (name: SurfaceName): name is ItermSurfaceName => name !== 'headless'

export function surfaceFor(name: SurfaceName, options: SurfaceOptions = {}): Surface {
  return isIterm(name) ? itermSurface(name, options) : headlessSurface(options)
}
