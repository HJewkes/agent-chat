import { spawn as nodeSpawn } from 'node:child_process'
import type { LaunchHandle, LaunchPlan, Surface } from '../types.js'
import { runAgentArgv } from './command.js'
import type { SurfaceOptions } from './options.js'

/**
 * No terminal at all: a detached child whose streams stay open for A8's
 * stream-json reader. Detached is the load-bearing part — the broker is what
 * survives every session, and an agent it spawned must not die with the request.
 */
export function headlessSurface(options: SurfaceOptions = {}): Surface {
  return {
    name: 'headless',
    interactive: false,
    launch: async (plan: LaunchPlan): Promise<LaunchHandle> => {
      const spawn = options.spawn ?? nodeSpawn
      const child = spawn(process.execPath, runAgentArgv(plan.agentId), {
        detached: true,
        // Piped rather than ignored so stdout stays available to be read as
        // stream-json; the brief itself goes in via the plan, not this stdin.
        stdio: ['pipe', 'pipe', 'pipe'],
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
