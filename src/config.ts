import fs from 'node:fs'
import { logEvent } from './broker/log.js'
import { DEFAULT_SLOTS } from './agents/semaphore.js'
import { configPath } from './paths.js'
import {
  DEFAULT_MACHINE_HEADLESS_AGENTS,
  DEFAULT_MACHINE_MEMORY_FREE_PERCENT,
  type MachineLimits,
} from './agents/machine-guard.js'
import {
  DEFAULT_MACHINE_STOP_LOAD5,
  DEFAULT_MACHINE_STOP_MEMORY_FREE_PERCENT,
  DEFAULT_MACHINE_STOP_PRESSURE_LEVEL,
  DEFAULT_MACHINE_STOP_SWAP_USED_PERCENT,
  type MachineStopLimits,
} from './agents/seats/stops.js'
import { DEFAULT_FULL_SUITE_SLOTS } from './suite-slots.js'
import { ALIAS_NAME } from './leak-guard/git-alias.js'
import { isHexColour, type PaneColourConfig } from '@titan-design/agent-surface'
import { isInteractiveSurface, type SurfaceName } from './protocol.js'
import { SEAT_SPAWN_MODES, type SeatSpawnMode } from './agents/seats/spawn-gate.js'
import { POOL_PICK_MODES, type PoolPickMode } from './agents/seats/pool-pick.js'
import {
  DEFAULT_PROCESS_KILL_BYTES,
  MIN_PROCESS_KILL_BYTES,
  PROCESS_GUARD_MODES,
  type ProcessGuardMode,
} from './agents/process-guard.js'

export interface AgentChatConfig {
  /** Path to a coordinator document; its `state_dir` relocates the autonomy root. */
  coordinatorConfig?: unknown
  agentSlots?: unknown
  worktreeBudget?: unknown
  worktreeOwnerReserve?: unknown
  contextHints?: unknown
  parkAdvice?: unknown
  ledgerShadow?: unknown
  orphanReapKill?: unknown
  poolPick?: unknown
  seatSpawnGate?: unknown
  permissionHookTimeoutSeconds?: unknown
  decider?: unknown
  noticeTtlHours?: unknown
  ghWriteGapSeconds?: unknown
  reportBatchSeconds?: unknown
  paneColours?: unknown
  machineHeadlessAgents?: unknown
  machineMemoryFreePercent?: unknown
  machineStopMemoryFreePercent?: unknown
  machineStopLoad5?: unknown
  machineStopSwapUsedPercent?: unknown
  machineStopPressureLevel?: unknown
  fullSuiteSlots?: unknown
  coordinatorGrantableTools?: unknown
  poolProbe?: unknown
  tmuxSurfaceOnLinux?: unknown
  processKillBytes?: unknown
  processGuardMode?: unknown
  gitShellAliases?: unknown
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
    load5: numberFrom('machineStopLoad5', config.machineStopLoad5, DEFAULT_MACHINE_STOP_LOAD5),
    swapUsedPercent:
      config.machineStopSwapUsedPercent === null
        ? null
        : numberFrom(
            'machineStopSwapUsedPercent',
            config.machineStopSwapUsedPercent,
            DEFAULT_MACHINE_STOP_SWAP_USED_PERCENT,
            100,
          ),
    pressureLevel: pressureLevelFrom(config.machineStopPressureLevel),
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
 */
export const DEFAULT_CONTEXT_HINTS: { default: ContextHintPolicy; profiles: HintTable } = {
  default: { tokens: 250_000, boundary: 'episode boundary' },
  profiles: {
    implementer: { tokens: 200_000, boundary: 'natural stopping point' },
    'implementer-lite': { tokens: 200_000, boundary: 'natural stopping point' },
    peer: { tokens: 250_000, boundary: 'assignment boundary' },
    planner: null,
    researcher: null,
    explorer: null,
    reviewer: null,
  },
}

/**
 * The policy for a session's profile, or null for "never hint". No profile means
 * a human-driven session and gets `default`, as does a profile nobody listed.
 * Invalid entries in `contextHints` fall back to the built-in value, logged.
 */
export function resolveContextHintPolicy(profile: string | undefined): ContextHintPolicy | null {
  const raw = readConfig().contextHints
  const configured = isObject(raw) ? raw : {}
  const profiles = isObject(configured.profiles) ? configured.profiles : {}
  const fallback = policyFrom('default', configured.default, DEFAULT_CONTEXT_HINTS.default)
  if (profile === undefined) return fallback
  if (Object.hasOwn(profiles, profile)) {
    const builtIn = DEFAULT_CONTEXT_HINTS.profiles[profile] ?? fallback
    return profiles[profile] === null ? null : policyFrom(profile, profiles[profile], builtIn)
  }
  return Object.hasOwn(DEFAULT_CONTEXT_HINTS.profiles, profile)
    ? (DEFAULT_CONTEXT_HINTS.profiles[profile] ?? null)
    : fallback
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

/**
 * Null means never advise: `parkAdvice.enabled` is false, the surface is headless, or the
 * profile is one the context hint never addresses.
 */
export function resolveParkAdvicePolicy(
  profile: string | undefined,
  surface: string | undefined,
): ParkAdvicePolicy | null {
  if (surface !== undefined && !isInteractiveSurface(surface as SurfaceName)) return null
  if (resolveContextHintPolicy(profile) === null) return null
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
