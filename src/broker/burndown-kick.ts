import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { burndownLedgerPath, cliEntry, home } from '../paths.js'
import { ledgerLockHolder } from '../agents/burndown/ledger.js'
import { jobEnv } from '../mirror/plist.js'
import type { AppendInput, EventStore } from './event-store.js'
import { logEvent } from './log.js'

/**
 * CC-1111: a burndown agent's exit, or its retire when `burndown release` drops its claim, frees a slot the
 * 10-minute timer would leave idle for minutes. The broker answers with one `burndown tick --once` about
 * `KICK_DEBOUNCE_MS` later; every exit inside that window rides the same tick. The tick's ledger lock is the
 * single-flight lock, shared with the timer: the kick never launches while it is held, and a kicked tick that
 * still races the timer refuses under the lock as any second tick does. The timer stays the backstop.
 */
export const KICK_DEBOUNCE_MS = 30_000

const KICK_KINDS: ReadonlySet<string> = new Set(['agent_exited', 'agent_retired'])

export interface KickPorts {
  /** Whether the tick spawned this agent (`spawned_as: burndown` on its spawn row). */
  isBurndownSpawn: (agentId: string) => boolean
  /** The live pid holding the tick's ledger lock, or undefined. */
  lockHolder: () => number | undefined
  /** Starts one detached tick and calls `done` when it ends; must not wait for it. */
  launch: (done: () => void) => void
  log: (event: string, detail: Record<string, unknown>) => void
  debounceMs?: number
}

export interface Kicker {
  offer: (row: AppendInput) => void
  stop: () => void
}

/** The first qualifying row arms the timer and later ones coalesce into it, so a stream of exits cannot starve it. */
export function burndownKicker(ports: KickPorts): Kicker {
  const delay = ports.debounceMs ?? KICK_DEBOUNCE_MS
  let timer: NodeJS.Timeout | undefined
  let running = false
  let coalesced = 0

  const arm = (): void => {
    timer = setTimeout(fire, delay)
    timer.unref()
  }
  const fire = (): void => {
    timer = undefined
    const holder = running ? 'kicked tick' : ports.lockHolder()
    if (holder !== undefined) {
      ports.log('burndown_kick_deferred', { holder, coalesced })
      return arm()
    }
    ports.log('burndown_kick', { coalesced })
    coalesced = 0
    running = true
    ports.launch(() => {
      running = false
    })
  }
  const offer = (row: AppendInput): void => {
    if (!KICK_KINDS.has(row.kind) || row.ref === undefined || !ports.isBurndownSpawn(row.ref)) return
    coalesced += 1
    if (timer === undefined) arm()
  }
  return { offer, stop: () => clearTimeout(timer) }
}

/** Watches `core`'s appends and kicks real ticks. Returns its stop. */
export function startBurndownKick(core: {
  readonly events: Pick<EventStore, 'agentEventsFor'>
  onAppend: (watch: (row: AppendInput) => void) => () => void
}): () => void {
  const kicker = burndownKicker({
    isBurndownSpawn: agentId =>
      core.events
        .agentEventsFor(agentId)
        .some(r => r.kind === 'agent_spawned' && r.meta['spawned_as'] === 'burndown'),
    lockHolder: () => ledgerLockHolder(burndownLedgerPath()),
    launch: launchTick,
    log: logEvent,
  })
  const unwatch = core.onAppend(kicker.offer)
  return () => {
    unwatch()
    kicker.stop()
  }
}

const USER_BUS_ENV = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const

/**
 * The timer job's command and env plus the user bus. systemd hands the timer job its bus; the kick has to pass
 * it, or `systemctl --user` fails in the tick's service check and reads `not loaded` (CC-1144).
 */
export function kickCommand(source: NodeJS.ProcessEnv): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  const env = jobEnv(source)
  for (const key of USER_BUS_ENV) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return { command: process.execPath, args: [cliEntry(), 'burndown', 'tick', '--once'], env }
}

/** The kick command, detached so the broker never waits on it; output appends to a log. */
function launchTick(done: () => void): void {
  let out: number | undefined
  try {
    out = fs.openSync(path.join(home(), 'burndown-kick.log'), 'a')
    const { command, args, env } = kickCommand(process.env)
    const child = spawn(command, args, { detached: true, stdio: ['ignore', out, out], env })
    child.once('exit', done)
    child.once('error', (err: Error) => {
      logEvent('burndown_kick_failed', { error: err.message })
      done()
    })
    child.unref()
  } catch (err) {
    logEvent('burndown_kick_failed', { error: (err as Error).message })
    done()
  } finally {
    if (out !== undefined) fs.closeSync(out)
  }
}
