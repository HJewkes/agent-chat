import fs from 'node:fs'
import { logEvent } from './broker/log.js'
import { DEFAULT_SLOTS } from './agents/semaphore.js'
import { configPath } from './paths.js'

interface AgentChatConfig {
  agentSlots?: unknown
  worktreeBudget?: unknown
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

function positiveIntegerFrom(key: keyof AgentChatConfig, fallback: number): number {
  const value = readConfig()[key]
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  logEvent('config_invalid', { key, value, fallback })
  return fallback
}
