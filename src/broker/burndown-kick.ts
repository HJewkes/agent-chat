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
  /** CC-1151: a hand-run tick's kick; fires now unless a kick is armed, a kicked tick runs or the lock is held. */
  request: () => string
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
  const fire = (): string => {
    timer = undefined
    const holder = running ? 'kicked tick' : ports.lockHolder()
    if (holder !== undefined) {
      ports.log('burndown_kick_deferred', { holder, coalesced })
      arm()
      return `deferred: ${holder} holds the tick; one runs after it`
    }
    ports.log('burndown_kick', { coalesced })
    coalesced = 0
    running = true
    ports.launch(() => {
      running = false
    })
    return 'launched'
  }
  const offer = (row: AppendInput): void => {
    if (!KICK_KINDS.has(row.kind) || row.ref === undefined || !ports.isBurndownSpawn(row.ref)) return
    coalesced += 1
    if (timer === undefined) arm()
  }
  const request = (): string => {
    coalesced += 1
    return timer === undefined ? fire() : 'coalesced: a kicked tick is already due'
  }
  return { offer, request, stop: () => clearTimeout(timer) }
}

/** Watches `core`'s appends and kicks real ticks. Returns the kicker, for hand-run kicks, and its stop. */
export function startBurndownKick(core: {
  readonly events: Pick<EventStore, 'agentEventsFor'>
  onAppend: (watch: (row: AppendInput) => void) => () => void
}): { kicker: Kicker; stop: () => void } {
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
  const stop = (): void => {
    unwatch()
    kicker.stop()
  }
  return { kicker, stop }
}

const USER_BUS_ENV = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const

export interface JobCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * The timer job's env plus the user bus. systemd hands the timer job its bus; the kick has to pass
 * it, or `systemctl --user` fails in the tick's service check and reads `not loaded` (CC-1144).
 */
export function kickEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env = jobEnv(source)
  for (const key of USER_BUS_ENV) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

/** The timer job's command, with `kickEnv`. */
export function kickCommand(source: NodeJS.ProcessEnv): JobCommand {
  return { command: process.execPath, args: [cliEntry(), 'burndown', 'tick', '--once'], env: kickEnv(source) }
}

/** Runs `job` detached so the broker never waits on it; output appends to `logName` under the home. */
export function launchDetached(job: JobCommand, logName: string, failEvent: string, done: () => void): void {
  let out: number | undefined
  try {
    out = fs.openSync(path.join(home(), logName), 'a')
    const child = spawn(job.command, job.args, { detached: true, stdio: ['ignore', out, out], env: job.env })
    child.once('exit', done)
    child.once('error', (err: Error) => {
      logEvent(failEvent, { error: err.message })
      done()
    })
    child.unref()
  } catch (err) {
    logEvent(failEvent, { error: (err as Error).message })
    done()
  } finally {
    if (out !== undefined) fs.closeSync(out)
  }
}

/** CC-1111: every kicked tick appends its full stdout, about 120 MB a day unrotated. */
export const KICK_LOG_MAX_BYTES = 10 * 1024 * 1024

const KICK_LOG = 'burndown-kick.log'

/** Keeps one `.1` generation. A running child keeps its fd, so its output lands in `.1`; kicks are single-flight. */
export function rotateKickLog(file: string, maxBytes: number): void {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`)
  } catch {
    // Missing file or unwritable directory: the launch's open decides what happens next.
  }
}

function launchTick(done: () => void): void {
  rotateKickLog(path.join(home(), KICK_LOG), KICK_LOG_MAX_BYTES)
  launchDetached(kickCommand(process.env), KICK_LOG, 'burndown_kick_failed', done)
}
