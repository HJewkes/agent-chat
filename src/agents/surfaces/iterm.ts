import { execFileSync } from 'node:child_process'
import type { SurfaceName } from '../../protocol.js'
import type { LaunchHandle, LaunchPlan, Surface } from '../types.js'
import { runAgentCommand } from './command.js'
import { SurfaceRefused, type AppleScriptRunner, type SurfaceOptions } from './options.js'

/**
 * The iTerm2 surfaces, and the two lessons that must survive from `iterm-panes.sh`:
 *
 * 1. Target the anchor session by the UUID inside `ITERM_SESSION_ID`, iterating
 *    windows/tabs/sessions to find it. NEVER `current window` — that follows user
 *    focus, so panes land in whichever window is frontmost when the script runs,
 *    which is rarely the one the human was looking at when they asked.
 * 2. Do not title anything here. iTerm's `set name` does not stick (the running
 *    job overwrites it); `run-agent` emits an OSC 0 escape instead.
 */

export type ItermSurfaceName = Extract<SurfaceName, `iterm-${string}`>

/** Returned by the search scripts when the anchor session no longer exists. */
const NO_ANCHOR = '@@no-anchor@@'

const osascript: AppleScriptRunner = script =>
  execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()

const asString = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/** `ITERM_SESSION_ID` is `w0t1p2:UUID`; only the UUID identifies a session. */
const anchorUuid = (anchor: string | undefined): string | undefined => {
  const uuid = anchor?.slice(anchor.lastIndexOf(':') + 1).trim()
  return uuid === undefined || uuid === '' ? undefined : uuid
}

const findAnchor = (uuid: string): string => `
  set anchorSession to missing value
  set anchorWindow to missing value
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then
          set anchorSession to s
          set anchorWindow to w
        end if
      end repeat
    end repeat
  end repeat
  if anchorSession is missing value then return ${asString(NO_ANCHOR)}`

/** Splits the anchor pane, or opens a tab in the anchor's window. Never a new window. */
const beside = (surface: ItermSurfaceName, uuid: string, command: string): string => {
  const open =
    surface === 'iterm-pane'
      ? '  tell anchorSession to set spawned to (split vertically with default profile)'
      : '  tell anchorWindow to set spawned to (current session of (create tab with default profile))'
  return `tell application "iTerm2"${findAnchor(uuid)}
${open}
  tell spawned to write text ${asString(command)}
  return unique ID of spawned
end tell`
}

/** The fallback everything lands on: needs no anchor, so it cannot fail to find one. */
const newWindow = (command: string): string => `tell application "iTerm2"
  set spawned to (current session of (create window with default profile))
  tell spawned to write text ${asString(command)}
  return unique ID of spawned
end tell`

/**
 * Asked without launching it: `is running` is false for an app that is not up,
 * where a `tell` would start iTerm2 and drop a window on an unsuspecting desktop.
 */
const itermRunning = (run: AppleScriptRunner): boolean => {
  try {
    return run('application "iTerm2" is running') === 'true'
  } catch {
    return false
  }
}

function requireIterm(options: SurfaceOptions, run: AppleScriptRunner): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin')
    throw new SurfaceRefused(`iTerm2 surfaces need macOS (this is ${platform}); use surface 'headless'`)
  if (!itermRunning(run)) throw new SurfaceRefused("iTerm2 is not running; use surface 'headless'")
}

/**
 * The ladder of §5.4, in order: no anchor -> a window; anchor recorded but gone
 * -> a window plus a notice; no iTerm2 at all -> refuse, naming headless.
 */
function launchIterm(surface: ItermSurfaceName, plan: LaunchPlan, options: SurfaceOptions): LaunchHandle {
  const run = options.runAppleScript ?? osascript
  requireIterm(options, run)
  const command = runAgentCommand(plan.agentId)
  const uuid = anchorUuid(options.anchor)

  if (surface !== 'iterm-window' && uuid !== undefined) {
    const paneRef = run(beside(surface, uuid, command))
    if (paneRef !== NO_ANCHOR) return { surface, paneRef }
    options.onNotice?.(`anchor session ${uuid} is gone; opening an iTerm window instead of ${surface}`)
  }
  return { surface: 'iterm-window', paneRef: run(newWindow(command)) }
}

export function itermSurface(name: ItermSurfaceName, options: SurfaceOptions = {}): Surface {
  return {
    name,
    interactive: true,
    launch: async (plan: LaunchPlan): Promise<LaunchHandle> => launchIterm(name, plan, options),
  }
}
