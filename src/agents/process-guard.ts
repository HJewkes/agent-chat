import type { ProcRow } from '../broker/reaper.js'

export const DEFAULT_PROCESS_KILL_BYTES = 8 * 1024 ** 3
/** A smaller limit is a typo (`8` meaning 8 GiB), not a policy: it would kill every agent's children. */
export const MIN_PROCESS_KILL_BYTES = 1024 ** 3
export const PROCESS_GUARD_MODES = ['kill', 'log', 'off'] as const
export type ProcessGuardMode = (typeof PROCESS_GUARD_MODES)[number]

export interface VictimOptions {
  brokerPid: number
  uid: number
}

export interface Victim {
  row: ProcRow
  root: ProcRow
}

const INIT_PID = 1
const AGENT_PROGRAMS = new Set(['claude', 'codex', 'titan-factory'])
const FACTORY_SCRIPT_RE = /(^|\/)titan-factory$|\/factory\/dist\/bin\.js$/
const CODEX_SCRIPT_RE = /(^|\/)codex(\.js)?$/
const AGENT_CHAT_SCRIPT_RE = /(^|\/)agent-chat$|\/dist\/cli\.js$/

function basename(path: string): string {
  return path.split('/').pop() ?? ''
}

/**
 * Matched on argv, never on `comm` (every node process reads `MainThread` on Linux) and never on a
 * substring of the whole command line, so `grep titan-factory` is not a root.
 */
export function isRoot(row: ProcRow, brokerPid: number): boolean {
  if (row.pid === brokerPid) return true
  const [argv0 = '', ...args] = row.command.split(/\s+/)
  const program = basename(argv0)
  if (AGENT_PROGRAMS.has(program)) return true
  if (program === 'agent-chat') return isCodexRun(args)
  if (program !== 'node') return false
  const [script = '', ...scriptArgs] = args
  if (FACTORY_SCRIPT_RE.test(script) || CODEX_SCRIPT_RE.test(script)) return true
  return AGENT_CHAT_SCRIPT_RE.test(script) && isCodexRun(scriptArgs)
}

function isCodexRun(args: string[]): boolean {
  return args[0] === 'codex' && args[1] === 'run'
}

/** The nearest root above `row`, or undefined. A visited set bounds the walk on a ppid cycle. */
export function rootOf(row: ProcRow, byPid: Map<number, ProcRow>, brokerPid: number): ProcRow | undefined {
  const visited = new Set<number>([row.pid])
  for (let parent = byPid.get(row.ppid); parent !== undefined; parent = byPid.get(parent.ppid)) {
    if (visited.has(parent.pid)) return undefined
    visited.add(parent.pid)
    if (isRoot(parent, brokerPid)) return parent
  }
  return undefined
}

function protectedPids(byPid: Map<number, ProcRow>, brokerPid: number): Set<number> {
  const pids = new Set<number>([INIT_PID, brokerPid])
  for (let row = byPid.get(brokerPid); row !== undefined && !pids.has(row.ppid); row = byPid.get(row.ppid)) {
    pids.add(row.ppid)
  }
  return pids
}

/** Processes of the broker's uid above `limitBytes` that descend from a root; roots themselves never qualify. */
export function runawayVictims(rows: ProcRow[], limitBytes: number, opts: VictimOptions): Victim[] {
  const byPid = new Map(rows.map(r => [r.pid, r]))
  const spared = protectedPids(byPid, opts.brokerPid)
  const victims: Victim[] = []
  for (const row of rows) {
    if (row.uid !== opts.uid || row.rssKb * 1024 <= limitBytes) continue
    if (spared.has(row.pid) || isRoot(row, opts.brokerPid)) continue
    const root = rootOf(row, byPid, opts.brokerPid)
    if (root !== undefined) victims.push({ row, root })
  }
  return victims
}
