import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
  readTable: () => Promise<ProcRow[]>
  kill: (pid: number) => void
  log: (entry: { pid: number; cwd: string; rssKb: number; command: string }) => void
  cwdOf: (pid: number) => Promise<string>
  options: () => SelectOptions
}

const ORPHAN_PPID = 1
const TITLE_RE = /^node \(vitest \d+\)$/
const WORKER_SCRIPT_RE = /\/vitest\/dist\/workers\/(forks|threads|vmForks|vmThreads)\.js$/
const DAG_CHECK_SCRIPT_SUFFIX = '/scripts/dag-check-self.mjs'
const LOGGED_COMMAND_MAX = 200

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
    const ageMs = parseEtime(m[4] ?? '')
    if (!Number.isFinite(ageMs)) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      startMs: now - ageMs,
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

/** Anchored on argv: only a `node` process whose script is the target, never a substring of argv. */
function isTarget(command: string): boolean {
  if (TITLE_RE.test(command)) return true
  const [argv0 = '', ...args] = command.split(/\s+/)
  if (argv0.split('/').pop() !== 'node') return false
  const script = args.find(a => !a.startsWith('-')) ?? ''
  return script.endsWith(DAG_CHECK_SCRIPT_SUFFIX) || WORKER_SCRIPT_RE.test(script)
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
export async function reapOnce(deps: ReaperDeps): Promise<number[]> {
  const reaped: number[] = []
  for (const row of selectOrphans(await deps.readTable(), deps.options())) {
    const cwd = await deps.cwdOf(row.pid)
    try {
      deps.kill(row.pid)
    } catch {
      continue
    }
    deps.log({
      pid: row.pid,
      cwd,
      rssKb: row.rssKb,
      command: row.command.slice(0, LOGGED_COMMAND_MAX),
    })
    reaped.push(row.pid)
  }
  return reaped
}

/** Sweeps on an unref'd interval, never overlapping. Returns its cancel. */
export function startReaper(deps: ReaperDeps, intervalMs = 60_000): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    // A failed sweep must never take the broker down.
    void reapOnce(deps)
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export async function readPsTable(now = Date.now()): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,uid=,etime=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5000,
  })
  return parseTable(stdout, now)
}

/** Best effort: `?` when lsof cannot say. */
export async function lsofCwd(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    return /^n(.+)$/m.exec(stdout)?.[1] ?? '?'
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
