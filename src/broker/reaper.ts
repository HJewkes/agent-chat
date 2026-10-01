import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export interface ProcRow {
  pid: number
  ppid: number
  uid: number
  startMs: number
  rssKb: number
  command: string
}

export interface SelectOptions {
  uid: number
  now: number
  minAgeMs: number
  selfPid: number
  /** Commands containing any of these paths are never reaped (the installed CLI). */
  excludePaths: string[]
}

export interface ReaperDeps {
  readTable: () => ProcRow[]
  kill: (pid: number) => void
  log: (entry: { pid: number; cwd: string; rssKb: number; command: string }) => void
  cwdOf: (pid: number) => string
  options: () => SelectOptions
}

const ORPHAN_PPID = 1
const WORKER_RE = /\(vitest \d+\)|\/vitest\/dist\/workers\/\w+\.js/
const DAG_CHECK_RE = /dag-check-self\.mjs/
const BROKER_RE = /dist\/cli\.js\s+broker(\s|$)/
const THROWAWAY_DIR_RE = /\/\.worktrees\/|\/var\/folders\/|\/tmp\//

/** Parses ps etime: `05:33`, `01:02:03` or `2-03:04:05`, to milliseconds. */
export function parseEtime(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = (clock ?? '').split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h = 0, m = 0, s = 0] = parts
  return ((Number(days) * 24 + h) * 60 * 60 + m * 60 + s) * 1000
}

/** Parses `ps -axo pid=,ppid=,uid=,etime=,rss=,command=` output. */
export function parseTable(text: string, now: number): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m === null) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      startMs: now - parseEtime(m[4] ?? '0'),
      rssKb: Number(m[5]),
      command: m[6] ?? '',
    })
  }
  return rows
}

function ancestorsOf(table: ProcRow[], pid: number): Set<number> {
  const byPid = new Map(table.map(r => [r.pid, r]))
  const chain = new Set<number>([pid])
  for (let row = byPid.get(pid); row !== undefined && !chain.has(row.ppid); row = byPid.get(row.ppid)) {
    chain.add(row.ppid)
  }
  return chain
}

function isTarget(command: string): boolean {
  return WORKER_RE.test(command) || DAG_CHECK_RE.test(command) || isTestBroker(command)
}

function isTestBroker(command: string): boolean {
  return BROKER_RE.test(command) && THROWAWAY_DIR_RE.test(command)
}

/** Orphans (PPID 1) of the current user that look like test debris and are old enough. */
export function selectOrphans(table: ProcRow[], opts: SelectOptions): ProcRow[] {
  const protectedPids = ancestorsOf(table, opts.selfPid)
  return table.filter(
    row =>
      row.ppid === ORPHAN_PPID &&
      row.uid === opts.uid &&
      opts.now - row.startMs >= opts.minAgeMs &&
      !protectedPids.has(row.pid) &&
      !opts.excludePaths.some(p => row.command.includes(p)) &&
      isTarget(row.command),
  )
}

/** One sweep. Returns the pids it signalled. */
export function reapOnce(deps: ReaperDeps): number[] {
  const reaped: number[] = []
  for (const row of selectOrphans(deps.readTable(), deps.options())) {
    try {
      deps.kill(row.pid)
    } catch {
      continue
    }
    deps.log({ pid: row.pid, cwd: deps.cwdOf(row.pid), rssKb: row.rssKb, command: row.command })
    reaped.push(row.pid)
  }
  return reaped
}

/** Sweeps on an unref'd interval. Returns its cancel. */
export function startReaper(deps: ReaperDeps, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    try {
      reapOnce(deps)
    } catch {
      // A failed sweep must never take the broker down.
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function readPsTable(now = Date.now()): ProcRow[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,uid=,etime=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseTable(out, now)
}

/** Best effort: `?` when lsof cannot say. */
export function lsofCwd(pid: number): string {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /^n(.+)$/m.exec(out)?.[1] ?? '?'
  } catch {
    return '?'
  }
}

/** Real paths of the CLI this broker runs from and of the `agent-chat` on PATH. */
export function installedCliPaths(): string[] {
  const candidates = [process.argv[1], ...(process.env.PATH ?? '').split(':').map(d => `${d}/agent-chat`)]
  const real = new Set<string>()
  for (const c of candidates) {
    if (c === undefined || !fs.existsSync(c)) continue
    real.add(fs.realpathSync(c))
  }
  return [...real]
}
