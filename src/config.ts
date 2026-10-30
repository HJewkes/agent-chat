import fs from 'node:fs'
import { logEvent } from './broker/log.js'
import { DEFAULT_SLOTS } from './agents/semaphore.js'
import { configPath } from './paths.js'
import {
  DEFAULT_MACHINE_CPU_PRESSURE_PERCENT,
  DEFAULT_MACHINE_DISK_BYTES_PERCENT,
  DEFAULT_MACHINE_HEADLESS_AGENTS,
  DEFAULT_MACHINE_MEMORY_FREE_PERCENT,
  DEFAULT_MACHINE_TMP_BYTES_PERCENT,
  DEFAULT_MACHINE_TMP_INODES_PERCENT,
  type MachineLimits,
} from './agents/machine-guard.js'
import type { HeadroomLimits, HeadroomResource } from './agents/host-headroom.js'
import {
  DEFAULT_MACHINE_STOP_CPU_PRESSURE_PERCENT,
  DEFAULT_MACHINE_STOP_DISK_BYTES_PERCENT,
  DEFAULT_MACHINE_STOP_LOAD5,
  DEFAULT_MACHINE_STOP_MEMORY_FREE_PERCENT,
  DEFAULT_MACHINE_STOP_PRESSURE_LEVEL,
  DEFAULT_MACHINE_STOP_SWAP_USED_PERCENT,
  DEFAULT_MACHINE_STOP_TMP_BYTES_PERCENT,
  DEFAULT_MACHINE_STOP_TMP_INODES_PERCENT,
  type MachineStopLimits,
} from './agents/seats/stops.js'
import { DEFAULT_FULL_SUITE_SLOTS } from './suite-slots.js'
import { ALIAS_NAME } from './leak-guard/git-alias.js'
import { isHexColour, type PaneColourConfig } from '@titan-design/agent-surface'
import { isInteractiveSurface, type SurfaceName } from './protocol.js'
import { SEAT_SPAWN_MODES, type SeatSpawnMode } from './agents/seats/spawn-gate.js'
import { POOL_PICK_MODES, type PoolPickMode } from './agents/seats/pool-pick.js'
import { roleOfProfile } from './agents/seats/agent-rows.js'
import { PACE_CONTROLLER_MODES, type PaceControllerMode } from './agents/seats/pace.js'
import {
  DEFAULT_PROCESS_KILL_BYTES,
  MIN_PROCESS_KILL_BYTES,
  PROCESS_GUARD_MODES,
  type ProcessGuardMode,
} from './agents/process-guard.js'
import { PROFILE_DRIFT_MODES, type ProfileDriftMode } from './agents/profile-baseline.js'
import { DEFAULT_ROTATION, type RotationConfig } from './agents/account-rotation.js'
import {
  DEFAULT_CRASH_LOOP_LAUNCHES,
  DEFAULT_CRASH_LOOP_SECONDS,
  type CrashLoopLimits,
} from './agents/crash-loop.js'

export interface AgentChatConfig {
  /** Path to a coordinator document; its `state_dir` relocates the autonomy root. */
  coordinatorConfig?: unknown
  agentSlots?: unknown
  worktreeBudget?: unknown
  reviewerWorktreeBudget?: unknown
  worktreeOwnerReserve?: unknown
  contextHints?: unknown
  parkAdvice?: unknown
  ledgerShadow?: unknown
  orphanReapKill?: unknown
  poolPick?: unknown
  paceController?: unknown
  seatSpawnGate?: unknown
  seatStewards?: unknown
  permissionHookTimeoutSeconds?: unknown
  decider?: unknown
  noticeTtlHours?: unknown
  /** CC-1684: `null` keeps `codex-pending/<name>` dirs for good. */
  codexPendingTtlHours?: unknown
  ghWriteGapSeconds?: unknown
  reportBatchSeconds?: unknown
  paneColours?: unknown
  machineHeadlessAgents?: unknown
  machineMemoryFreePercent?: unknown
  machineCpuPressurePercent?: unknown
  machineStopCpuPressurePercent?: unknown
  machineTmpInodesPercent?: unknown
  machineTmpBytesPercent?: unknown
  machineDiskBytesPercent?: unknown
  machineStopTmpInodesPercent?: unknown
  machineStopTmpBytesPercent?: unknown
  machineStopDiskBytesPercent?: unknown
  machineStopMemoryFreePercent?: unknown
  machineStopLoad5?: unknown
  /** CC-1671 S4: a crash this soon after launch counts; `null` turns the crash-loop stop off. */
  crashLoopSeconds?: unknown
  /** CC-1671 S4: crashes in a row before respawning stops; `null` turns the crash-loop stop off. */
  crashLoopLaunches?: unknown
  machineStopSwapUsedPercent?: unknown
  machineStopPressureLevel?: unknown
  fullSuiteSlots?: unknown
  coordinatorGrantableTools?: unknown
  poolProbe?: unknown
  tmuxSurfaceOnLinux?: unknown
  machines?: unknown
  processKillBytes?: unknown
  processGuardMode?: unknown
  gitShellAliases?: unknown
  autoRetire?: unknown
  autoPark?: unknown
  machineHoldOperators?: unknown
  dispatchOverlapExempt?: unknown
  profileDrift?: unknown
  hostProof?: unknown
  accountRotation?: unknown
}

const loggedInvalid = new Set<string>()

/**
 * The guard reads config every 2 s (CC-495), so one typo would log on every read. Each distinct bad
 * content is logged once per config file per process; fixing it and breaking it differently logs again.
 */
function logInvalidOnce(detail: Record<string, unknown>): void {
  const key = JSON.stringify([configPath(), detail])
  if (loggedInvalid.has(key)) return
  loggedInvalid.add(key)
  logEvent('config_invalid', detail)
}

export const readAgentChatConfig = (): AgentChatConfig => readConfig()

/** Mirrors `loadHooksConfig` in `agents/hooks.ts`: missing file is fine, malformed JSON is logged and ignored. */
function readConfig(): AgentChatConfig {
  let raw: string
  try {
    raw = fs.readFileSync(configPath(), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as AgentChatConfig) : {}
  } catch (err) {
    logInvalidOnce({ path: configPath(), error: String(err) })
    return {}
  }
}

/**
 * The standing agent-slot cap, from `config.json`'s `agentSlots`.
 *
 * A missing key keeps `DEFAULT_SLOTS`. A present but non-integer, non-positive
 * value also falls back to `DEFAULT_SLOTS`, logged rather than refused at
 * startup — a broker that won't come up over a typo'd number is worse than one
 * running with the old cap, the same tradeoff `loadHooksConfig` makes for a
 * malformed `hooks.json`.
 */
export function resolveAgentSlots(): number {
  return positiveIntegerFrom('agentSlots', DEFAULT_SLOTS)
}

/** Per-repository worktree cap (`worktreeBudget`), read per spawn so a new value needs no broker restart. */
export function resolveWorktreeBudget(fallback: number): number {
  return positiveIntegerFrom('worktreeBudget', fallback)
}

/** CC-1040: per-repository cap on reviewer worktrees (`reviewerWorktreeBudget`), a pool apart from `worktreeBudget`. */
export function resolveReviewerWorktreeBudget(fallback: number): number {
  return positiveIntegerFrom('reviewerWorktreeBudget', fallback)
}

export const DEFAULT_WORKTREE_OWNER_RESERVE = 2

/**
 * CC-872: worktree slots per repo kept free for the owner, from `worktreeOwnerReserve`.
 * Unlike the fallback-and-log keys, a present value that is not a non-negative integer throws:
 * a silent fallback would hand the owner's slots to agents.
 */
export function resolveWorktreeOwnerReserve(): number {
  const value = readConfig().worktreeOwnerReserve
  if (value === undefined) return DEFAULT_WORKTREE_OWNER_RESERVE
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw new Error(
    `config.json worktreeOwnerReserve must be a non-negative integer, got ${JSON.stringify(value)}`,
  )
}

/**
 * CC-118's shadow-write flag, read once at broker boot. On by default as of
 * slice 5, once the backfill rehearsal (slice 3) and the divergence verifier
 * (slice 4) were both reviewed. `AGENT_CHAT_LEDGER_SHADOW=0|1` overrides the file.
 */
export function resolveLedgerShadow(): boolean {
  const override = process.env.AGENT_CHAT_LEDGER_SHADOW
  if (override === '0' || override === '1') return override === '1'
  const value = readConfig().ledgerShadow
  if (value === undefined || typeof value === 'boolean') return value !== false
  logInvalidOnce({ key: 'ledgerShadow', value, fallback: true })
  return true
}

/**
 * CC-898: whether the orphan reap may signal. Off unless `orphanReapKill` is `true` in config (or
 * `AGENT_CHAT_ORPHAN_REAP=kill`): until then it only logs `orphans_would_reap`, so the owner sees
 * live output before anything is killed.
 */
export function resolveOrphanReapKill(): boolean {
  const override = process.env.AGENT_CHAT_ORPHAN_REAP
  if (override === 'kill' || override === 'dry-run') return override === 'kill'
  const value = readConfig().orphanReapKill
  if (value === undefined || typeof value === 'boolean') return value === true
  logInvalidOnce({ key: 'orphanReapKill', value, fallback: false })
  return false
}

/**
 * CC-529: whether the seat watchdog may spend a headless turn to read a pool with no fresh reading.
 * Off unless `poolProbe` is `true`: the turn is unattended and starts a five_hour window on an idle pool.
 */
export function resolvePoolProbe(): boolean {
  const value = readConfig().poolProbe
  if (value === undefined || typeof value === 'boolean') return value === true
  logInvalidOnce({ key: 'poolProbe', value, fallback: false })
  return false
}

/** CC-804: whether a Linux host puts iTerm surfaces in tmux windows. Off unless `tmuxSurfaceOnLinux` is `true`. */
export function resolveTmuxOnLinux(): boolean {
  const value = readConfig().tmuxSurfaceOnLinux
  if (value === undefined || typeof value === 'boolean') return value === true
  logInvalidOnce({ key: 'tmuxSurfaceOnLinux', value, fallback: false })
  return false
}

/**
 * CC-951: teleport destination aliases, alias → hostname, so `to: "mac"` names a machine. Empty unless
 * `machines` is an object of non-empty strings; any bad entry drops the whole map rather than half of it.
 */
export function resolveMachines(): Record<string, string> {
  const value = readConfig().machines
  if (value === undefined) return {}
  const isHost = (host: unknown): host is string => typeof host === 'string' && host.trim() !== ''
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isHost)
  )
    return value as Record<string, string>
  logInvalidOnce({ key: 'machines', value, fallback: {} })
  return {}
}

/**
 * CC-606: whether the broker's pool pick for an unpinned seat spawn is only recorded (`shadow`, the default)
 * or also billed (`enforce`); `off` skips it. From `config.json`'s `poolPick`, read per spawn.
 */
export function resolvePoolPickMode(): PoolPickMode {
  const value = readConfig().poolPick
  if (value === undefined) return 'shadow'
  const mode = POOL_PICK_MODES.find(known => known === value)
  if (mode !== undefined) return mode
  logInvalidOnce({ key: 'poolPick', value, fallback: 'shadow' })
  return 'shadow'
}

/**
 * CC-1094: what an agent spawn of a profile whose file changed since broker start gets: a warning (`flag`,
 * the default, since the owner edits profiles at runtime) or a refusal (`refuse`). Read once when the broker
 * starts (CC-1202): an edit takes effect at restart, so a worker that reaches config.json cannot loosen refuse
 * to flag.
 */
export function resolveProfileDriftMode(): ProfileDriftMode {
  const value = readConfig().profileDrift
  if (value === undefined) return 'flag'
  const mode = PROFILE_DRIFT_MODES.find(known => known === value)
  if (mode !== undefined) return mode
  logInvalidOnce({ key: 'profileDrift', value, fallback: 'flag' })
  return 'flag'
}

export const HOST_PROOF_MODES = ['off', 'enforce'] as const
export type HostProofMode = (typeof HOST_PROOF_MODES)[number]

/**
 * CC-1063: whether a configured machine's `host_hello` must carry a valid launcher-key proof (`enforce`)
 * or a bad proof is only logged (`off`, the default until launchers answer the challenge and hold keys).
 * From `config.json`'s `hostProof`, read per hello.
 */
export function resolveHostProofMode(): HostProofMode {
  const value = readConfig().hostProof
  if (value === undefined) return 'off'
  const mode = HOST_PROOF_MODES.find(known => known === value)
  if (mode !== undefined) return mode
  logInvalidOnce({ key: 'hostProof', value, fallback: 'off' })
  return 'off'
}

/**
 * CC-1104: whether the pace controller only logs its verdict beside per_run and per_day (`shadow`, the
 * default), replaces them (`on`), or is skipped (`off`). From `config.json`'s `paceController`, read per call.
 */
export function resolvePaceControllerMode(): PaceControllerMode {
  const value = readConfig().paceController
  if (value === undefined) return 'shadow'
  const mode = PACE_CONTROLLER_MODES.find(known => known === value)
  if (mode !== undefined) return mode
  logInvalidOnce({ key: 'paceController', value, fallback: 'shadow' })
  return 'shadow'
}

/**
 * CC-932: how a seat's hand spawn of a claimed or brief-ready task is treated: `off` (the default), `warn`
 * (log `seat_spawn_overlap` and spawn) or `refuse`. From `config.json`'s `seatSpawnGate`, read per spawn.
 */
export function resolveSeatSpawnMode(): SeatSpawnMode {
  const value = readConfig().seatSpawnGate
  if (value === undefined) return 'off'
  const mode = SEAT_SPAWN_MODES.find(known => known === value)
  if (mode !== undefined) return mode
  logInvalidOnce({ key: 'seatSpawnGate', value, fallback: 'off' })
  return 'off'
}

/**
 * CC-966: the steward of a non-resident seat, from `config.json`'s `seatStewards` (`{"<seat>": "<steward>"}`).
 * CC-1501: peer mail to a mapped seat goes to the owner queue while it has no active session, except
 * the steward's own; human sends keep the seat's hold. Read per send; an invalid entry is logged and read as no steward, so the seat keeps
 * today's dark-seat hold.
 */
export function resolveSeatSteward(seat: string): string | undefined {
  const stewards = readConfig().seatStewards
  if (stewards === undefined) return undefined
  if (!isObject(stewards) || Array.isArray(stewards)) {
    logInvalidOnce({ key: 'seatStewards', value: stewards, fallback: 'no stewards' })
    return undefined
  }
  const value = stewards[seat]
  if (value === undefined || (typeof value === 'string' && value !== '' && value !== seat)) return value
  logInvalidOnce({ key: `seatStewards.${seat}`, value, fallback: 'no steward' })
  return undefined
}

/**
 * CC-921: whether the broker parks and retires `spawner`'s agents when they exit on a final report.
 * `autoRetire.onFinalReport` is `true` for every spawner or a list of spawner names; off by default.
 * Read per exit, so a change needs no broker restart. Anything else is logged and read as off.
 */
export function resolveAutoRetireOnReport(spawner: string): boolean {
  const autoRetire = readConfig().autoRetire
  if (autoRetire === undefined) return false
  const value = isObject(autoRetire) ? autoRetire.onFinalReport : autoRetire
  if (value === undefined || typeof value === 'boolean') return value === true
  if (Array.isArray(value) && value.every(name => typeof name === 'string')) return value.includes(spawner)
  logInvalidOnce({ key: 'autoRetire.onFinalReport', value, fallback: false })
  return false
}

/**
 * CC-1039: whether the broker parks a non-reviewer agent's clean, pushed tree when it exits.
 * `autoPark.onExit` is on by default; `false` turns it off. Read per exit, so a change needs no
 * broker restart. Anything else is logged and read as on.
 */
export function resolveAutoParkOnExit(): boolean {
  const autoPark = readConfig().autoPark
  const value = isObject(autoPark) ? autoPark.onExit : autoPark
  if (value === undefined || typeof value === 'boolean') return value !== false
  logInvalidOnce({ key: 'autoPark.onExit', value, fallback: true })
  return true
}

/**
 * CC-1546: `accountRotation` (`enabled`, `ceilingPct`, `exclude`), read per spawn. Each field
 * that is absent or invalid takes its default, an invalid one logged; a non-object is all defaults.
 */
export function resolveAccountRotation(): RotationConfig {
  const value = readConfig().accountRotation
  if (value === undefined) return DEFAULT_ROTATION
  if (!isObject(value) || Array.isArray(value)) {
    logInvalidOnce({ key: 'accountRotation', value, fallback: DEFAULT_ROTATION })
    return DEFAULT_ROTATION
  }
  return {
    enabled: rotationEnabled(value.enabled),
    ceilingPct: numberFrom('accountRotation.ceilingPct', value.ceilingPct, DEFAULT_ROTATION.ceilingPct, 100),
    exclude: rotationExclude(value.exclude),
  }
}

function rotationEnabled(value: unknown): boolean {
  if (value === undefined || typeof value === 'boolean') return value !== false
  logInvalidOnce({ key: 'accountRotation.enabled', value, fallback: DEFAULT_ROTATION.enabled })
  return DEFAULT_ROTATION.enabled
}

function rotationExclude(value: unknown): readonly string[] {
  if (value === undefined) return DEFAULT_ROTATION.exclude
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value as string[]
  logInvalidOnce({ key: 'accountRotation.exclude', value, fallback: DEFAULT_ROTATION.exclude })
  return DEFAULT_ROTATION.exclude
}

/**
 * The one durable agent id allowed to send `decided` (autonomy slice 3), from
 * `config.json`'s `decider.agentId`, set once by the human for one durable
 * decider (slice 4f option c); the burndown tick only reads it. Read per frame.
 * Absent means no decider.
 */
export function resolveDeciderAgentId(): string | undefined {
  const decider = readConfig().decider
  if (decider === undefined) return undefined
  const agentId = isObject(decider) ? decider.agentId : undefined
  if (typeof agentId === 'string' && agentId !== '') return agentId
  logInvalidOnce({ key: 'decider.agentId', value: agentId, fallback: 'no decider' })
  return undefined
}

export const DEFAULT_MACHINE_HOLD_OPERATORS: readonly string[] = ['tp-operator']

/**
 * CC-957: the agents whose machine-wide sends open and lift a chat HOLD, from `machineHoldOperators`,
 * read per call. Anything but a non-empty list of names is logged and read as the default.
 */
export function resolveMachineHoldOperators(): readonly string[] {
  const value = readConfig().machineHoldOperators
  if (value === undefined) return DEFAULT_MACHINE_HOLD_OPERATORS
  const isName = (name: unknown): name is string => typeof name === 'string' && name !== ''
  if (Array.isArray(value) && value.length > 0 && value.every(isName)) return value
  logInvalidOnce({ key: 'machineHoldOperators', value, fallback: DEFAULT_MACHINE_HOLD_OPERATORS })
  return DEFAULT_MACHINE_HOLD_OPERATORS
}

/** How long a headless agent's PermissionRequest hook blocks for the human (CC-144); read per spawn. */
export const DEFAULT_PERMISSION_HOOK_TIMEOUT_S = 1800

export function resolvePermissionHookTimeout(): number {
  return positiveIntegerFrom('permissionHookTimeoutSeconds', DEFAULT_PERMISSION_HOOK_TIMEOUT_S)
}

/** How long a plain notice stays in the human queue before it counts as expired (CC-173). */
export const DEFAULT_NOTICE_TTL_HOURS = 72

/** `noticeTtlHours` in `config.json`, in milliseconds; read per query so an edit needs no broker restart. */
export function resolveNoticeTtlMs(): number {
  return positiveIntegerFrom('noticeTtlHours', DEFAULT_NOTICE_TTL_HOURS) * 3_600_000
}

/** How long `codex-pending/<name>` waits for its name to run again (CC-1684). */
export const DEFAULT_CODEX_PENDING_TTL_HOURS = 336

/** `codexPendingTtlHours` in `config.json`, in milliseconds; `null` turns the sweep off. Read per run. */
export function resolveCodexPendingTtlMs(): number | null {
  if (readConfig().codexPendingTtlHours === null) return null
  return positiveIntegerFrom('codexPendingTtlHours', DEFAULT_CODEX_PENDING_TTL_HOURS) * 3_600_000
}

/** Minimum spacing between two `agent-chat gh-write` calls machine-wide (CC-253). */
export const DEFAULT_GH_WRITE_GAP_S = 3

/** `ghWriteGapSeconds` in `config.json`, in milliseconds; read per call. */
export function resolveGhWriteGapMs(): number {
  return positiveIntegerFrom('ghWriteGapSeconds', DEFAULT_GH_WRITE_GAP_S) * 1000
}

/** How long a worker's report to its spawner waits for others to join it in one push (CC-321). */
export const DEFAULT_REPORT_BATCH_S = 20

/** A longer window is read as a typo: a report held for minutes is a stalled coordinator. */
export const MAX_REPORT_BATCH_S = 300

/**
 * `reportBatchSeconds` in `config.json`, in milliseconds; 0 turns batching off.
 * `AGENT_CHAT_REPORT_BATCH_SECONDS` overrides the file. Read per report, so an edit needs no broker restart.
 */
export function resolveReportBatchMs(): number {
  const override = process.env.AGENT_CHAT_REPORT_BATCH_SECONDS
  const fromEnv = override === undefined || override.trim() === '' ? undefined : Number(override)
  // A bad override falls back to the file before the default: the file is the owner's standing choice.
  const seconds = reportBatchSeconds(fromEnv) ?? reportBatchSeconds(readConfig().reportBatchSeconds)
  return (seconds ?? DEFAULT_REPORT_BATCH_S) * 1000
}

function reportBatchSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_REPORT_BATCH_S)
    return value
  logInvalidOnce({ key: 'reportBatchSeconds', value, fallback: DEFAULT_REPORT_BATCH_S })
  return undefined
}

/** CC-406's machine-wide spawn limits, read per spawn so an edit needs no broker restart. */
export function resolveMachineLimits(): MachineLimits {
  let memoryFreePercent = positiveIntegerFrom('machineMemoryFreePercent', DEFAULT_MACHINE_MEMORY_FREE_PERCENT)
  if (memoryFreePercent > 100) {
    logInvalidOnce({
      key: 'machineMemoryFreePercent',
      value: memoryFreePercent,
      fallback: DEFAULT_MACHINE_MEMORY_FREE_PERCENT,
    })
    memoryFreePercent = DEFAULT_MACHINE_MEMORY_FREE_PERCENT
  }
  return {
    headlessAgents: positiveIntegerFrom('machineHeadlessAgents', DEFAULT_MACHINE_HEADLESS_AGENTS),
    memoryFreePercent,
    cpuPressurePercent: percentOrNullFrom(
      'machineCpuPressurePercent',
      readConfig().machineCpuPressurePercent,
      DEFAULT_MACHINE_CPU_PRESSURE_PERCENT,
    ),
    headroom: headroomLimitsFrom(readConfig(), SPAWN_HEADROOM_KEYS),
  }
}

type HeadroomKeys = Record<HeadroomResource, readonly [keyof AgentChatConfig & string, number]>

const SPAWN_HEADROOM_KEYS: HeadroomKeys = {
  tmp_inodes: ['machineTmpInodesPercent', DEFAULT_MACHINE_TMP_INODES_PERCENT],
  tmp_bytes: ['machineTmpBytesPercent', DEFAULT_MACHINE_TMP_BYTES_PERCENT],
  disk_bytes: ['machineDiskBytesPercent', DEFAULT_MACHINE_DISK_BYTES_PERCENT],
}

const STOP_HEADROOM_KEYS: HeadroomKeys = {
  tmp_inodes: ['machineStopTmpInodesPercent', DEFAULT_MACHINE_STOP_TMP_INODES_PERCENT],
  tmp_bytes: ['machineStopTmpBytesPercent', DEFAULT_MACHINE_STOP_TMP_BYTES_PERCENT],
  disk_bytes: ['machineStopDiskBytesPercent', DEFAULT_MACHINE_STOP_DISK_BYTES_PERCENT],
}

/** CC-1265: /tmp and disk-root used-percent limits from config.json; null disables one. */
function headroomLimitsFrom(config: AgentChatConfig, keys: HeadroomKeys): HeadroomLimits {
  const limit = ([configKey, fallback]: HeadroomKeys[HeadroomResource]) => ({
    percent: percentOrNullFrom(configKey, config[configKey], fallback),
    configKey,
  })
  return {
    tmp_inodes: limit(keys.tmp_inodes),
    tmp_bytes: limit(keys.tmp_bytes),
    disk_bytes: limit(keys.disk_bytes),
  }
}

/** CC-1671 S4: read at each exit, so an edit needs no restart. */
export function resolveCrashLoop(): CrashLoopLimits {
  const { crashLoopSeconds: seconds, crashLoopLaunches: launches } = readConfig()
  return {
    seconds: seconds === null ? null : positiveIntegerFrom('crashLoopSeconds', DEFAULT_CRASH_LOOP_SECONDS),
    launches:
      launches === null ? null : positiveIntegerFrom('crashLoopLaunches', DEFAULT_CRASH_LOOP_LAUNCHES),
  }
}

/** CC-431: where a seat stops on machine pressure, read per call so an edit needs no restart. */
export function resolveMachineStopLimits(): MachineStopLimits {
  const config = readConfig()
  return {
    memoryFreePercent: numberFrom(
      'machineStopMemoryFreePercent',
      config.machineStopMemoryFreePercent,
      DEFAULT_MACHINE_STOP_MEMORY_FREE_PERCENT,
      100,
    ),
    load5:
      config.machineStopLoad5 === null
        ? null
        : numberFrom('machineStopLoad5', config.machineStopLoad5, DEFAULT_MACHINE_STOP_LOAD5),
    swapUsedPercent: percentOrNullFrom(
      'machineStopSwapUsedPercent',
      config.machineStopSwapUsedPercent,
      DEFAULT_MACHINE_STOP_SWAP_USED_PERCENT,
    ),
    cpuPressurePercent: percentOrNullFrom(
      'machineStopCpuPressurePercent',
      config.machineStopCpuPressurePercent,
      DEFAULT_MACHINE_STOP_CPU_PRESSURE_PERCENT,
    ),
    pressureLevel: pressureLevelFrom(config.machineStopPressureLevel),
    headroom: headroomLimitsFrom(config, STOP_HEADROOM_KEYS),
  }
}

function pressureLevelFrom(value: unknown): number {
  if (value === undefined) return DEFAULT_MACHINE_STOP_PRESSURE_LEVEL
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4) return value
  logInvalidOnce({
    key: 'machineStopPressureLevel',
    value,
    fallback: DEFAULT_MACHINE_STOP_PRESSURE_LEVEL,
  })
  return DEFAULT_MACHINE_STOP_PRESSURE_LEVEL
}

/** CC-495: the rss above which an agent-descended process is a runaway. Read every guard tick. */
export function resolveProcessKillBytes(): number {
  const value = readConfig().processKillBytes
  if (value === undefined) return DEFAULT_PROCESS_KILL_BYTES
  if (typeof value === 'number' && Number.isFinite(value) && value >= MIN_PROCESS_KILL_BYTES) return value
  logInvalidOnce({ key: 'processKillBytes', value, fallback: DEFAULT_PROCESS_KILL_BYTES })
  return DEFAULT_PROCESS_KILL_BYTES
}

/** CC-495: `log` by default, and an unknown value falls back to `log` so a typo never turns killing on. */
export function resolveProcessGuardMode(): ProcessGuardMode {
  const value = readConfig().processGuardMode
  if (value === undefined) return 'log'
  const mode = PROCESS_GUARD_MODES.find(known => known === value)
  if (mode !== undefined) return mode
  logInvalidOnce({ key: 'processGuardMode', value, fallback: 'log' })
  return 'log'
}

/** A percent in (0, 100], or null in config.json to turn the check off. */
function percentOrNullFrom(key: string, value: unknown, fallback: number): number | null {
  return value === null ? null : numberFrom(key, value, fallback, 100)
}

function numberFrom(key: string, value: unknown, fallback: number, max = Infinity): number {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max) return value
  logInvalidOnce({ key, value, fallback })
  return fallback
}

/** How many full test suites may run at once machine-wide (CC-406). */
export function resolveFullSuiteSlots(): number {
  return positiveIntegerFrom('fullSuiteSlots', DEFAULT_FULL_SUITE_SLOTS)
}

/** CC-451: the web-read tools a coordinator may grant a child it does not hold itself, and the only ones. */
export const WEB_READ_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']

/**
 * `coordinatorGrantableTools` in `config.json`, read per spawn; `[]` turns the exemption off.
 * It can only narrow `WEB_READ_TOOLS`: any other name, `*` included, is logged and dropped,
 * and a non-array grants nothing rather than the default, because this key widens authority.
 */
export function resolveCoordinatorGrantableTools(): string[] {
  const value = readConfig().coordinatorGrantableTools
  if (value === undefined) return [...WEB_READ_TOOLS]
  if (!Array.isArray(value)) {
    logInvalidOnce({ key: 'coordinatorGrantableTools', value, fallback: [] })
    return []
  }
  const known = value.filter(
    (tool): tool is string => typeof tool === 'string' && WEB_READ_TOOLS.includes(tool),
  )
  const ignored = value.filter(tool => !known.includes(tool as string))
  if (ignored.length > 0)
    logInvalidOnce({ key: 'coordinatorGrantableTools', value: ignored, fallback: 'ignored' })
  return known
}

/**
 * CC-613: the `!` git aliases an agent's git shim lets run, from `gitShellAliases`, read per spawn.
 * It fails closed: a non-array lists nothing, and an entry that is not an alias name is logged and dropped.
 */
export function resolveGitShellAliases(): string[] {
  const value = readConfig().gitShellAliases
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    logInvalidOnce({ key: 'gitShellAliases', value, fallback: [] })
    return []
  }
  const isName = (name: unknown): name is string => typeof name === 'string' && ALIAS_NAME.test(name)
  const names = value.filter(isName)
  const ignored = value.filter(name => !isName(name))
  if (ignored.length > 0) logInvalidOnce({ key: 'gitShellAliases', value: ignored, fallback: 'ignored' })
  return names.map(name => name.toLowerCase())
}

function positiveIntegerFrom(key: keyof AgentChatConfig, fallback: number): number {
  const value = readConfig()[key]
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  logInvalidOnce({ key, value, fallback })
  return fallback
}

/** When to tell a session its context is large, and which boundary to name. Advisory only. */
export interface ContextHintPolicy {
  tokens: number
  /** Completes "at your next …". */
  boundary: string
}

/** A null entry means that role is never hinted. */
type HintTable = Record<string, ContextHintPolicy | null>

/**
 * Absolute tokens, not percent of window: 70% of a 1M window is 700k, far past
 * where the cost of carrying context dominates. Numbers chosen by the owner on 2026-09-21.
 * CC-290: this table is also the one source of each role's retire threshold
 * (`retireThresholdK`); the charter's `retire_k` no longer feeds anything.
 */
export const DEFAULT_CONTEXT_HINTS: { default: ContextHintPolicy; profiles: HintTable } = {
  default: { tokens: 250_000, boundary: 'episode boundary' },
  profiles: {
    implementer: { tokens: 200_000, boundary: 'natural stopping point' },
    'implementer-lite': { tokens: 200_000, boundary: 'natural stopping point' },
    peer: { tokens: 250_000, boundary: 'assignment boundary' },
    planner: { tokens: 250_000, boundary: 'plan section' },
    researcher: null,
    explorer: null,
    reviewer: { tokens: 300_000, boundary: 'verdict' },
  },
}

/**
 * The policy for a session's profile, or null for "never hint". No profile means
 * a human-driven session and gets `default`, as does a profile nobody listed.
 * A profile with no entry of its own takes the longest built-in key its name
 * contains, so `bd-implementer` is held to `implementer` (CC-290).
 * Invalid entries in `contextHints` fall back to the built-in value, logged.
 */
export function resolveContextHintPolicy(profile: string | undefined): ContextHintPolicy | null {
  const raw = readConfig().contextHints
  const configured = isObject(raw) ? raw : {}
  const profiles = isObject(configured.profiles) ? configured.profiles : {}
  const fallback = policyFrom('default', configured.default, DEFAULT_CONTEXT_HINTS.default)
  if (profile === undefined) return fallback
  const key = Object.hasOwn(profiles, profile) ? profile : hintKeyOf(profile)
  if (key === undefined) return fallback
  if (Object.hasOwn(profiles, key)) {
    const builtIn = DEFAULT_CONTEXT_HINTS.profiles[key] ?? fallback
    return profiles[key] === null ? null : policyFrom(key, profiles[key], builtIn)
  }
  return DEFAULT_CONTEXT_HINTS.profiles[key] ?? null
}

/** The exact built-in key, else the longest built-in key the profile name contains. */
function hintKeyOf(profile: string): string | undefined {
  const builtIn = Object.keys(DEFAULT_CONTEXT_HINTS.profiles)
  if (builtIn.includes(profile)) return profile
  return builtIn
    .filter(key => profile.includes(key))
    .sort((a, b) => b.length - a.length)
    .at(0)
}

/**
 * CC-290: thousands of context tokens past which an agent of this profile is due to
 * retire. Undefined for a profile naming no role, or one that is never hinted.
 */
export function retireThresholdK(profile: string): number | undefined {
  if (roleOfProfile(profile) === 'other') return undefined
  const policy = resolveContextHintPolicy(profile)
  return policy === null ? undefined : Math.round(policy.tokens / 1000)
}

function policyFrom(key: string, value: unknown, fallback: ContextHintPolicy): ContextHintPolicy {
  if (value === undefined) return fallback
  if (isObject(value) && isPositiveInteger(value.tokens)) {
    const boundary =
      typeof value.boundary === 'string' && value.boundary !== '' ? value.boundary : fallback.boundary
    return { tokens: value.tokens, boundary }
  }
  logInvalidOnce({ key: `contextHints.${key}`, value, fallback })
  return fallback
}

/** When to tell a session idle on the human that its warm cache is about to expire (CC-135). Advisory only. */
export interface ParkAdvicePolicy {
  tokens: number
  /** How long before cache expiry the notice goes out. */
  leadMinutes: number
  /** The cache TTL assumed when the status line reports no expiry. */
  ttlMinutes: number
}

/** 200k is where the CC-135 cold-rebuild cost cells start; keep-warm is deliberately absent. */
export const DEFAULT_PARK_ADVICE: ParkAdvicePolicy = { tokens: 200_000, leadMinutes: 8, ttlMinutes: 60 }

/** CC-290: these roles now carry a context hint as their retire threshold, but still get no park advice. */
const NO_PARK_ADVICE_ROLES: ReadonlySet<string> = new Set(['planner', 'reviewer'])

/**
 * Null means never advise: `parkAdvice.enabled` is false, the surface is headless, or the
 * profile is one the context hint never addresses, or a
 * planner or reviewer.
 */
export function resolveParkAdvicePolicy(
  profile: string | undefined,
  surface: string | undefined,
): ParkAdvicePolicy | null {
  if (surface !== undefined && !isInteractiveSurface(surface as SurfaceName)) return null
  if (resolveContextHintPolicy(profile) === null) return null
  if (profile !== undefined && NO_PARK_ADVICE_ROLES.has(roleOfProfile(profile))) return null
  const raw = readConfig().parkAdvice
  const configured = isObject(raw) ? raw : {}
  if (configured.enabled === false) return null
  const number = (key: keyof ParkAdvicePolicy): number => {
    const value = configured[key]
    if (value === undefined || isPositiveInteger(value)) return value ?? DEFAULT_PARK_ADVICE[key]
    logInvalidOnce({ key: `parkAdvice.${key}`, value, fallback: DEFAULT_PARK_ADVICE[key] })
    return DEFAULT_PARK_ADVICE[key]
  }
  return { tokens: number('tokens'), leadMinutes: number('leadMinutes'), ttlMinutes: number('ttlMinutes') }
}

/**
 * CC-327: `paneColours.seats.<seat>` and `paneColours.profiles.<profile>`, each a `#rrggbb`.
 * A malformed entry is logged and dropped, so that pane falls back to its hashed colour.
 */
export function resolvePaneColourConfig(): PaneColourConfig {
  const raw = readConfig().paneColours
  const configured = isObject(raw) ? raw : {}
  return {
    seats: hexEntries('seats', configured.seats),
    profiles: hexEntries('profiles', configured.profiles),
  }
}

function hexEntries(group: string, value: unknown): Record<string, string> {
  if (!isObject(value)) return {}
  const entries = Object.entries(value).filter(([key, colour]) => {
    if (isHexColour(colour)) return true
    logInvalidOnce({
      key: `paneColours.${group}.${key}`,
      value: colour,
      fallback: 'hashed colour',
    })
    return false
  })
  return Object.fromEntries(entries) as Record<string, string>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const isPositiveInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1
