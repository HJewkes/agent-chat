import fs from 'node:fs'
import { logEvent } from './broker/log.js'
import { DEFAULT_SLOTS } from './agents/semaphore.js'
import { configPath } from './paths.js'

interface AgentChatConfig {
  agentSlots?: unknown
  worktreeBudget?: unknown
  contextHints?: unknown
  ledgerShadow?: unknown
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
 * CC-118's shadow-write flag, read once at broker boot. Off by default until the
 * backfill rehearsal is reviewed. `AGENT_CHAT_LEDGER_SHADOW=0|1` overrides the file.
 */
export function resolveLedgerShadow(): boolean {
  const override = process.env.AGENT_CHAT_LEDGER_SHADOW
  if (override === '0' || override === '1') return override === '1'
  const value = readConfig().ledgerShadow
  if (value === undefined || typeof value === 'boolean') return value === true
  logEvent('config_invalid', { key: 'ledgerShadow', value, fallback: false })
  return false
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const isPositiveInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1
