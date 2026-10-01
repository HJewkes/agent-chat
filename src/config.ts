import fs from 'node:fs'
import { logEvent } from './broker/log.js'
import { DEFAULT_SLOTS } from './agents/semaphore.js'
import { configPath } from './paths.js'
import {
  DEFAULT_MACHINE_HEADLESS_AGENTS,
  DEFAULT_MACHINE_MEMORY_FREE_PERCENT,
  type MachineLimits,
} from './agents/machine-guard.js'
import { DEFAULT_FULL_SUITE_SLOTS } from './suite-slots.js'
import { isHexColour, type PaneColourConfig } from './agents/pane-identity.js'

interface AgentChatConfig {
  agentSlots?: unknown
  worktreeBudget?: unknown
  contextHints?: unknown
  ledgerShadow?: unknown
  permissionHookTimeoutSeconds?: unknown
  decider?: unknown
  noticeTtlHours?: unknown
  ghWriteGapSeconds?: unknown
  reportBatchSeconds?: unknown
  paneColours?: unknown
  machineHeadlessAgents?: unknown
  machineMemoryFreePercent?: unknown
  fullSuiteSlots?: unknown
}

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
    logEvent('config_invalid', { path: configPath(), error: String(err) })
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
  logEvent('config_invalid', { key: 'ledgerShadow', value, fallback: true })
  return true
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
  logEvent('config_invalid', { key: 'decider.agentId', value: agentId, fallback: 'no decider' })
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
  logEvent('config_invalid', { key: 'reportBatchSeconds', value, fallback: DEFAULT_REPORT_BATCH_S })
  return undefined
}

/** CC-406's machine-wide spawn limits, read per spawn so an edit needs no broker restart. */
export function resolveMachineLimits(): MachineLimits {
  let memoryFreePercent = positiveIntegerFrom('machineMemoryFreePercent', DEFAULT_MACHINE_MEMORY_FREE_PERCENT)
  if (memoryFreePercent > 100) {
    logEvent('config_invalid', {
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

/** How many full test suites may run at once machine-wide (CC-406). */
export function resolveFullSuiteSlots(): number {
  return positiveIntegerFrom('fullSuiteSlots', DEFAULT_FULL_SUITE_SLOTS)
}

function positiveIntegerFrom(key: keyof AgentChatConfig, fallback: number): number {
  const value = readConfig()[key]
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  logEvent('config_invalid', { key, value, fallback })
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
  logEvent('config_invalid', { key: `contextHints.${key}`, value, fallback })
  return fallback
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
    logEvent('config_invalid', {
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
