import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { home } from '../../paths.js'
import { budgetPath, type BudgetWindow } from '../budget.js'
import { resolveClaudeBin } from '../claude-bin.js'

/**
 * CC-529: a reading for a pool with no visible session. A headless session draws no status
 * line, but its stream-json output carries a `rate_limit_event` with both windows. One haiku
 * turn with no tools reads it, and the result goes into the pool's status cache under a fixed
 * session id, so every account-level reader sees it as the freshest row.
 */

export const PROBE_SESSION = 'pool-probe'
const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const PROBE_TIMEOUT_MS = 60_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(line)
    return isRecord(doc) ? doc : undefined
  } catch {
    return undefined
  }
}

function windowsOf(event: Record<string, unknown>): Record<string, BudgetWindow> {
  const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : {}
  const unified = isRecord(info.unifiedWindows) ? info.unifiedWindows : {}
  const windows: Record<string, BudgetWindow> = {}
  for (const [name, value] of Object.entries(unified)) {
    if (!isRecord(value) || typeof value.utilization !== 'number') continue
    const resetsAt = typeof value.resetsAt === 'number' ? { resets_at: value.resetsAt } : {}
    windows[name] = { used_pct: Math.round(value.utilization * 100), ...resetsAt }
  }
  return windows
}

/** The windows of the last `rate_limit_event` in a stream-json run; undefined unless it holds both. */
export function parseRateLimits(stdout: string): Record<string, BudgetWindow> | undefined {
  const events = stdout
    .split('\n')
    .map(parseLine)
    .filter(doc => doc?.type === 'rate_limit_event')
  const last = events.at(-1)
  const windows = last === undefined ? {} : windowsOf(last)
  return windows.five_hour === undefined || windows.seven_day === undefined ? undefined : windows
}

/** The status-cache document for a probe, in the status line writer's field names. */
export function probeDocument(windows: Record<string, BudgetWindow>, nowMs: number): string {
  const limits = Object.entries(windows).map(([name, w]) => [
    name,
    { used_percentage: w.used_pct, ...(w.resets_at === undefined ? {} : { resets_at: w.resets_at }) },
  ])
  const doc = {
    session_id: PROBE_SESSION,
    written_at: Math.round(nowMs / 1000),
    rate_limits: Object.fromEntries(limits),
  }
  return `${JSON.stringify(doc)}\n`
}

export interface ProbeDeps {
  /** One headless turn billed to `configDir`; returns its stream-json output and throws when it cannot run. */
  run: (configDir: string) => string
  write: (file: string, text: string) => void
  now: () => number
}

const PROBE_ARGS = [
  '-p',
  'ok',
  ...['--model', PROBE_MODEL],
  ...['--output-format', 'stream-json'],
  '--verbose',
  '--strict-mcp-config',
  ...['--mcp-config', '{"mcpServers":{}}'],
  ...['--setting-sources', ''],
  '--no-session-persistence',
  ...['--tools', ''],
  ...['--system-prompt', 'Reply ok.'],
]

function runClaude(configDir: string): string {
  const resolution = resolveClaudeBin({ env: process.env, stateDir: home() })
  if ('error' in resolution) throw new Error(resolution.error)
  return execFileSync(resolution.bin, PROBE_ARGS, {
    cwd: os.tmpdir(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

const liveDeps: ProbeDeps = { run: runClaude, write: writeAtomic, now: () => Date.now() }

/** False when the turn could not run or carried no reading; the pool then stays stale, which is reported. */
export function probePool(configDir: string, deps: ProbeDeps = liveDeps): boolean {
  let windows: Record<string, BudgetWindow> | undefined
  try {
    windows = parseRateLimits(deps.run(configDir))
  } catch {
    return false
  }
  if (windows === undefined) return false
  deps.write(budgetPath(PROBE_SESSION, configDir), probeDocument(windows, deps.now()))
  return true
}
