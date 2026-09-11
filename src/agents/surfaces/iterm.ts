import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

/** Returned by the teardown script when it found the session and closed it. */
const CLOSED = '@@closed@@'

const execFileAsync = promisify(execFile)

const osascript: AppleScriptRunner = async script =>
  (await execFileAsync('osascript', ['-e', script], { encoding: 'utf8' })).stdout.trim()

const asString = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/** `ITERM_SESSION_ID` is `w0t1p2:UUID`; only the UUID identifies a session. */
const anchorUuid = (anchor: string | undefined): string | undefined => {
  const uuid = anchor?.slice(anchor.lastIndexOf(':') + 1).trim()
  return uuid === undefined || uuid === '' ? undefined : uuid
}

/**
 * One pass for both sessions we might target. `columnUuid` is empty when there is
 * no column yet, and no session's unique ID is ever the empty string, so the
 * lookup simply finds nothing — which is also the correct answer when the column
 * pane existed and has since been closed.
 */
const findSessions = (uuid: string, columnUuid: string): string => `
  set anchorSession to missing value
  set anchorWindow to missing value
  set columnSession to missing value
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then
          set anchorSession to s
          set anchorWindow to w
        end if
        if (unique ID of s) is ${asString(columnUuid)} then
          set columnSession to s
        end if
      end repeat
    end repeat
  end repeat
  if anchorSession is missing value then return ${asString(NO_ANCHOR)}`

/**
 * Agents stack in a column beside the anchor, rather than each one splitting the
 * anchor again — which halved the coordinator's pane on every spawn and left a
 * row of equal columns. The first agent splits the anchor VERTICALLY, taking one
 * side; each later agent splits the previous AGENT pane HORIZONTALLY, so the
 * column subdivides and the anchor keeps the width it has.
 *
 * Falling back to the vertical split when the column session is gone is what
 * makes a closed agent pane self-healing: the next spawn starts a fresh column.
 *
 * There is no depth parameter here and there should not be one (CC-64). A column
 * is keyed by whose pane is being split, and the anchor is always the requester's
 * own pane, so an agent's own spawns land beside IT — one step further right, a
 * column per level, for free. See docs/agent-teams.md § placement.
 */
const beside = (
  surface: ItermSurfaceName,
  uuid: string,
  command: string,
  columnUuid: string = '',
): string => {
  const open =
    surface === 'iterm-pane'
      ? `  if columnSession is not missing value then
    tell columnSession to set spawned to (split horizontally with default profile)
  else
    tell anchorSession to set spawned to (split vertically with default profile)
  end if`
      : '  tell anchorWindow to set spawned to (current session of (create tab with default profile))'
  return `tell application "iTerm2"${findSessions(uuid, columnUuid)}
${open}
  tell spawned to write text ${asString(command)}
  return unique ID of spawned
end tell`
}

/**
 * Run the command IN the anchor session, rather than opening anything.
 *
 * For teleport, and only teleport: the anchor is the predecessor's own pane and
 * the predecessor has already exited, so its shell is back at a prompt. The
 * descendant lands exactly where the session it continues was sitting — same
 * window, same split, same place in the human's layout. Opening a tab instead
 * left a dead pane behind and moved the work somewhere nobody was looking.
 */
const inPlace = (uuid: string, command: string): string => `tell application "iTerm2"${findSessions(uuid, '')}
  tell anchorSession to write text ${asString(command)}
  return unique ID of anchorSession
end tell`

/** The fallback everything lands on: needs no anchor, so it cannot fail to find one. */
const newWindow = (command: string): string => `tell application "iTerm2"
  set spawned to (current session of (create window with default profile))
  tell spawned to write text ${asString(command)}
  return unique ID of spawned
end tell`

/**
 * Close one session, found the same way everything else here finds one.
 *
 * A session is the unit for all three surfaces: closing the last session of a
 * tab closes the tab, and the last tab of a window closes the window — so a
 * pane, a tab and a window all tear down through this one script. Finding
 * nothing is the ordinary case of a human who already closed it by hand.
 */
const closeSession = (uuid: string): string => `tell application "iTerm2"${findSessions(uuid, '')}
  tell anchorSession to close
  return ${asString(CLOSED)}
end tell`

/**
 * Asked without launching it: `is running` is false for an app that is not up,
 * where a `tell` would start iTerm2 and drop a window on an unsuspecting desktop.
 */
const itermRunning = async (run: AppleScriptRunner): Promise<boolean> => {
  try {
    return (await run('application "iTerm2" is running')) === 'true'
  } catch {
    return false
  }
}

async function requireIterm(options: SurfaceOptions, run: AppleScriptRunner): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin')
    throw new SurfaceRefused(`iTerm2 surfaces need macOS (this is ${platform}); use surface 'headless'`)
  if (!(await itermRunning(run))) throw new SurfaceRefused("iTerm2 is not running; use surface 'headless'")
}

/**
 * The ladder of §5.4, in order: no anchor -> a window; anchor recorded but gone
 * -> a window plus a notice; no iTerm2 at all -> refuse, naming headless.
 */
async function launchIterm(
  surface: ItermSurfaceName,
  plan: LaunchPlan,
  options: SurfaceOptions,
): Promise<LaunchHandle> {
  const run = options.runAppleScript ?? osascript
  await requireIterm(options, run)
  const command = runAgentCommand(plan.agentId)
  const uuid = anchorUuid(options.anchor)

  // Reuse is tried first and falls through to the ordinary ladder when the pane
  // has closed — a human who quit the whole window during the countdown should
  // still get their descendant, somewhere they can find it.
  if (options.reuseAnchor && uuid !== undefined) {
    // No `ownsSurface`: this pane was already open and this launch only wrote
    // into it. Whether the broker opened it in an earlier life is a question
    // about the PREDECESSOR, which only the supervisor can answer.
    const paneRef = await run(inPlace(uuid, command))
    if (paneRef !== NO_ANCHOR) return { surface, paneRef }
    options.onNotice?.(`pane ${uuid} is gone; opening an iTerm window rather than reusing it`)
  } else if (surface !== 'iterm-window' && uuid !== undefined) {
    const paneRef = await run(beside(surface, uuid, command, options.columnAfter))
    if (paneRef !== NO_ANCHOR) return { surface, paneRef, ownsSurface: true }
    options.onNotice?.(`anchor session ${uuid} is gone; opening an iTerm window instead of ${surface}`)
  }
  return { surface: 'iterm-window', paneRef: await run(newWindow(command)), ownsSurface: true }
}

/**
 * Close what this broker opened, and nothing else.
 *
 * Every failure here is benign and none of them should fail a shutdown: iTerm2
 * has quit, the human closed the pane themselves, osascript is unavailable. The
 * agent is going away either way, so a surface that outlives it is untidy rather
 * than wrong.
 */
async function closeIterm(handle: LaunchHandle, options: SurfaceOptions): Promise<boolean> {
  if (handle.ownsSurface !== true || handle.paneRef === undefined) return false
  const run = options.runAppleScript ?? osascript
  try {
    await requireIterm(options, run)
    return (await run(closeSession(handle.paneRef))) === CLOSED
  } catch {
    return false
  }
}

export function itermSurface(name: ItermSurfaceName, options: SurfaceOptions = {}): Surface {
  return {
    name,
    interactive: true,
    launch: (plan: LaunchPlan): Promise<LaunchHandle> => launchIterm(name, plan, options),
    close: (handle: LaunchHandle): Promise<boolean> => closeIterm(handle, options),
  }
}
