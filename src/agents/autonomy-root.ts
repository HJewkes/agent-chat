import fs from 'node:fs'
import path from 'node:path'
import { readAgentChatConfig, type AgentChatConfig } from '../config.js'
import { activeWorkRoot } from './active-work.js'

/** Mirrors `activeWorkRoot`'s override order, but against the env it is handed. */
const activeRootFrom = (env: NodeJS.ProcessEnv): string =>
  env.AGENT_CHAT_ACTIVE_WORK_ROOT || env.ACTIVE_ROOT || activeWorkRoot()

function documentStateDir(file: string): string | null {
  let state: unknown
  try {
    state = (JSON.parse(fs.readFileSync(file, 'utf8')) as { state_dir?: unknown }).state_dir
  } catch (err) {
    throw new Error(`config.json coordinatorConfig ${file} is unreadable: ${String(err)}`)
  }
  if (state === undefined || state === null) return null
  if (typeof state === 'string' && state !== '') return state
  throw new Error(`config.json coordinatorConfig ${file}: state_dir must be a non-empty string or null`)
}

/**
 * The one autonomy root. The coordinator document's `state_dir` (named by config.json's
 * `coordinatorConfig`) wins; otherwise the active-work path every reader used before.
 * A document that is set but unreadable throws: a silent fallback would split state across two roots.
 */
export function autonomyRoot(
  config: Pick<AgentChatConfig, 'coordinatorConfig'>,
  env: NodeJS.ProcessEnv,
  activeRoot?: string,
): string {
  const { coordinatorConfig } = config
  if (typeof coordinatorConfig === 'string' && coordinatorConfig !== '') {
    const stateDir = documentStateDir(coordinatorConfig)
    if (stateDir !== null) return stateDir
  }
  return path.join(activeRoot ?? activeRootFrom(env), 'claude-channels', 'sources', 'autonomy')
}

/** `autonomyRoot` against this machine's config.json and process env. */
export const currentAutonomyRoot = (activeRoot?: string): string =>
  autonomyRoot(readAgentChatConfig(), process.env, activeRoot)
