/**
 * A supervisor that can be "restarted" in-process, for tests about what a broker
 * restart keeps and what it loses.
 *
 * API:
 * - `startSupervisor({ slots?, settleMs? })` makes an isolated AGENT_CHAT_HOME,
 *   a BrokerCore over `<home>/events.db`, and a Supervisor on a stubbed launcher.
 * - `h.spawnAgent(name)` spawns a headless agent; its attach is stood in for.
 * - `h.restart(options?)` closes the supervisor and core, then builds new ones
 *   over the SAME events.db and home, optionally with a new cap. Presence is
 *   empty afterwards, as in a real restart.
 * - `h.reattach(names)` appends `agent_attached` for each named agent, which is
 *   what their MCP servers do on reconnecting to the new broker.
 * - `h.close()` tears everything down and removes the temp dirs.
 *
 * Nothing here launches a process: the launcher is stubbed, and a real `claude`
 * would start a detached broker against this home (see supervisor.test.ts).
 * The caller owns timers; use `vi.useFakeTimers()` if settle windows matter.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrokerCore, type Conn } from '../../broker/core.js'
import { EventLog } from '../../broker/event-log.js'
import { Registry } from '../../broker/registry.js'
import { Semaphore } from '../../agents/semaphore.js'
import { Supervisor, type SpawnOutcome } from '../../agents/supervisor.js'
import { autoAttach } from '../broker-harness.js'

export interface RestartHarness {
  readonly home: string
  readonly core: BrokerCore
  readonly supervisor: Supervisor
  readonly semaphore: Semaphore
  spawnAgent(name: string): Promise<SpawnOutcome>
  restart(options?: HarnessOptions): void
  reattach(names: readonly string[]): void
  close(): void
}

export interface HarnessOptions {
  slots?: number
  settleMs?: number
}

/** A child that starts and never exits, so the attach path decides what a test sees. */
const liveChild = (): { pid: number; unref: () => void; once: () => undefined } => ({
  pid: 4242,
  unref: () => undefined,
  once: () => undefined,
})

export function startSupervisor(options: HarnessOptions = {}): RestartHarness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-restart-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-restart-ws-'))
  process.env.AGENT_CHAT_HOME = home
  let generation = boot(home, options)

  return {
    home,
    get core() {
      return generation.core
    },
    get supervisor() {
      return generation.supervisor
    },
    get semaphore() {
      return generation.semaphore
    },
    spawnAgent: name =>
      generation.supervisor.spawn({
        name,
        profile: 'explorer',
        brief: 'restart harness',
        requestedBy: 'human',
        cwd: workspace,
        isolation: 'none',
        surface: 'headless',
      }),
    restart(next = options) {
      shutdown(generation)
      generation = boot(home, next)
    },
    reattach(names) {
      for (const name of names) {
        const identity = generation.core.agents.byName(name)
        if (!identity) throw new Error(`restart harness: no agent named "${name}"`)
        generation.core.append({ kind: 'agent_attached', actor: name, ref: identity.agentId })
      }
    },
    close() {
      shutdown(generation)
      delete process.env.AGENT_CHAT_HOME
      for (const dir of [home, workspace]) fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface Generation {
  core: BrokerCore
  supervisor: Supervisor
  semaphore: Semaphore
  stopAutoAttach: () => void
}

function boot(home: string, options: HarnessOptions): Generation {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const semaphore = new Semaphore(options.slots)
  const supervisor = new Supervisor(core, {
    semaphore,
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    surface: { platform: 'linux', spawn: liveChild },
  })
  return { core, supervisor, semaphore, stopAutoAttach: autoAttach(core) }
}

function shutdown(generation: Generation): void {
  generation.stopAutoAttach()
  generation.supervisor.close()
  generation.core.close()
}
