/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { hooksPath } from '../paths.js'
import { logEvent } from '../broker/log.js'

/**
 * CC-71: a generic agent-lifecycle extension point, modeled directly on
 * Claude Code's own `settings.json` hooks — a JSON file mapping an event name
 * to one or more shell commands, each invoked with the event payload as JSON
 * on stdin.
 *
 * This module (and `hooks.json` itself) names no specific consumer.
 * active-work — or anything else — registers its own commands here without
 * this codebase ever importing or referencing it. See
 * `docs/replacing-built-in-agent-dispatch.md` and AW-96 (active-work) for the
 * motivating case this was built for.
 */
export type HookEvent = 'on_spawn' | 'on_complete'

interface HooksConfig {
  on_spawn?: string[]
  on_complete?: string[]
}

function loadHooksConfig(): HooksConfig {
  let raw: string
  try {
    raw = fs.readFileSync(hooksPath(), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as HooksConfig) : {}
  } catch (err) {
    logEvent('hooks_config_invalid', { path: hooksPath(), error: String(err) })
    return {}
  }
}

/**
 * The slice of a spawned child a hook needs. Injected for the same reason
 * `SpawnFn` is in `agents/surfaces/options.ts`: tests exercise the real
 * dispatch logic (config lookup, JSON encoding, per-command isolation)
 * without launching a real shell.
 */
export interface HookProcess {
  stdin: { write: (chunk: string) => void; end: () => void }
  stderr?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void } | null
  on: (event: 'error', listener: (err: Error) => void) => void
}

export type HookSpawnFn = (command: string) => HookProcess

function defaultSpawn(command: string): HookProcess {
  return spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'pipe'] }) as unknown as HookProcess
}

/**
 * Fires every command registered for `event`, piping `payload` as JSON on
 * stdin. Fire-and-forget by design: a hook command's failure (nonzero exit,
 * spawn error, malformed `hooks.json`) is logged and never propagates — spawn
 * and exit handling in `supervisor.ts` must not depend on any hook, or an
 * operator's broken shell script would start failing agent spawns.
 */
export function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  opts: { spawn?: HookSpawnFn } = {},
): void {
  const commands = loadHooksConfig()[event]
  if (!commands || commands.length === 0) return
  const spawnFn = opts.spawn ?? defaultSpawn
  const body = JSON.stringify(payload)
  for (const command of commands) {
    try {
      const child = spawnFn(command)
      child.on('error', err => logEvent('hook_failed', { event, command, error: String(err) }))
      child.stderr?.on('data', (chunk: Buffer) =>
        logEvent('hook_stderr', { event, command, chunk: chunk.toString('utf8').slice(0, 500) }),
      )
      child.stdin.write(body)
      child.stdin.end()
    } catch (err) {
      logEvent('hook_failed', { event, command, error: String(err) })
    }
  }
}
