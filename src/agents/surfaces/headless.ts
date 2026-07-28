import { spawn as nodeSpawn } from 'node:child_process'
import type { LaunchHandle, LaunchPlan, Surface } from '../types.js'
import { runAgentArgv } from './command.js'
import type { SurfaceOptions } from './options.js'

/**
 * No terminal at all: a detached child with nowhere for its output to go.
 * Detached is the load-bearing part — the broker is what survives every session,
 * and an agent it spawned must not die with the request.
 */
/**
 * Exported so the regression test can spawn a real, loud process through the very
 * same stdio arrangement. Asserting the literal in a unit test would only restate
 * it; running a megabyte through it is what proves nothing blocks.
 */
export const HEADLESS_STDIO = ['ignore', 'ignore', 'ignore'] as const

export function headlessSurface(options: SurfaceOptions = {}): Surface {
  return {
    name: 'headless',
    interactive: false,
    launch: async (plan: LaunchPlan): Promise<LaunchHandle> => {
      const spawn = options.spawn ?? nodeSpawn
      const child = spawn(process.execPath, runAgentArgv(plan.agentId), {
        detached: true,
        // DISCARDED, and this must stay discarded. These were once ['pipe','pipe','pipe']
        // for a stream-json reader that was never built, which left a pipe with no
        // reader: a chatty agent filled the ~64KB kernel buffer, blocked on write, and
        // wedged forever while still looking healthy — attached, slot held, presence fine.
        //
        // A reader in the broker cannot be the fix. The child is detached and unref'd
        // precisely so it outlives us, so any reader we hold vanishes when the broker
        // exits and re-arms the same hang. Only the kernel can safely drain a stream
        // whose writer outlives its parent, and /dev/null is how you ask it to.
        //
        // Nothing is lost: Claude Code writes its own transcript for this session, and
        // we know the id because we assigned it. See `transcript.ts`.
        stdio: [...HEADLESS_STDIO],
      })
      child.unref()

      // Settled rather than pending, so nothing here keeps the broker's event
      // loop alive: the child is detached and unref'd precisely so it outlives
      // us, and a promise nobody awaits must not undo that.
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        child.once('exit', (code: number | null, signal: string | null) => resolve({ code, signal }))
        child.once('error', () => resolve({ code: null, signal: null }))
      })

      return {
        surface: 'headless',
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        exited,
      }
    },
  }
}
