import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-1671: what each live agent's process tree costs the machine, sampled on an interval and
 * recorded on its `agent_exited` row. The spawn gate's per-profile estimate reads those rows.
 *
 * A sample walks down from the agent's launcher and host pids, so its cost follows the agents'
 * trees rather than the size of the process table; reads are async, so a slow /proc never stalls
 * the broker's frames. Each tick is bounded by a pid budget and each file count by a cap.
 *
 * CPU sums utime, stime and the reaped-children counters of every live pid: a test worker that
 * ended between samples is still in its parent's counters, and a live child is not, so nothing
 * counts twice. A daemon reparented to init leaves the walk. RSS sums pages, so memory shared
 * between the tree's processes counts once per process: an upper bound.
 *
 * Linux only. A pid, file or tree that cannot be read is no sample, never a zero.
 */

export const FOOTPRINT_INTERVAL_MS = 10_000
export const MAX_PIDS_PER_TICK = 2_000
export const MAX_PIDS_PER_AGENT = 512
export const MAX_TMP_FILES = 10_000
/** A file walk costs far more than a stat read, and a TMPDIR grows slowly. */
export const TMP_SAMPLE_EVERY = 6

// USER_HZ and the page size are fixed by the Linux x86-64 and common arm64 ABIs this reads under.
const TICKS_PER_SECOND = 100
const PAGE_KB = 4
const AGENT_TMP_PREFIX = 'ac-'
const LIVE_STATES: ReadonlySet<string> = new Set(['spawning', 'live', 'detached'])

export interface ProcSample {
  ppid: number
  /** Own and reaped-children CPU, in clock ticks. */
  cpuTicks: number
  rssKb: number
  /** Kernel start time; a pid that keeps its number but changes this was recycled. */
  startTicks: number
}

/** Each read answers undefined or empty when the pid is gone. */
export interface FootprintProbe {
  stat(pid: number): Promise<ProcSample | undefined>
  children(pid: number): Promise<number[]>
  /** The process's TMPDIR at exec, undefined when unreadable or unset. */
  tmpDir(pid: number): Promise<string | undefined>
  /** Entries under `dir`, stopping at `cap`; undefined when it cannot be read. Never follows a symlink. */
  countFiles(dir: string, cap: number): Promise<number | undefined>
}

export interface Footprint {
  samples: number
  cpuSeconds: number
  rssPeakKb: number
  childrenPeak: number
  /** Absent when no TMPDIR was read. At {@link MAX_TMP_FILES} the true count may be higher. */
  tmpFilesPeak?: number
}

export interface FootprintTarget {
  agentId: string
  /** The launcher and the Claude Code host; either may be absent, and they may overlap. */
  rootPids: number[]
}

interface Tracked {
  footprint: Footprint
  /** Root pid to its start time, so a recycled pid is not read as this agent. */
  roots: Map<number, number>
  tmpDir?: string
}

/** Parses /proc/<pid>/stat, whose comm field may hold spaces and parentheses. */
export function parseProcStat(text: string): ProcSample | undefined {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const number = (index: number): number => Number(fields[index])
  const sample = {
    ppid: number(1),
    cpuTicks: number(11) + number(12) + number(13) + number(14),
    rssKb: number(21) * PAGE_KB,
    startTicks: number(19),
  }
  return Object.values(sample).every(Number.isFinite) ? sample : undefined
}

/** A launch's own `ac-<name>-<pid>` dir; a shared TMPDIR is not this agent's to be charged for. */
export function ownTmpDir(env: Readonly<Record<string, string>>): string | undefined {
  const dir = env.TMPDIR
  return dir !== undefined && path.basename(dir).startsWith(AGENT_TMP_PREFIX) ? dir : undefined
}

async function readOr<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}

/** Every thread's children file: a child belongs to the thread that forked it. */
async function procChildren(pid: number): Promise<number[]> {
  const threads = await fs.readdir(`/proc/${pid}/task`)
  const lists = await Promise.all(
    threads.map(tid => readOr(() => fs.readFile(`/proc/${pid}/task/${tid}/children`, 'utf8'), '')),
  )
  return lists.flatMap(list => list.split(' ').filter(Boolean).map(Number))
}

async function procTmpDir(pid: number): Promise<string | undefined> {
  const raw = await fs.readFile(`/proc/${pid}/environ`, 'utf8')
  const entries = raw.split('\0').map(entry => entry.split(/=(.*)/s).slice(0, 2) as [string, string])
  return ownTmpDir(Object.fromEntries(entries.filter(entry => entry.length === 2)))
}

async function walkFiles(root: string, cap: number): Promise<number> {
  let count = 0
  const pending = [root]
  for (let dir = pending.pop(); dir !== undefined && count < cap; dir = pending.pop()) {
    const entries = await readOr(() => fs.readdir(dir, { withFileTypes: true }), [])
    count += entries.length
    for (const entry of entries) if (entry.isDirectory()) pending.push(path.join(dir, entry.name))
  }
  return Math.min(count, cap)
}

export const procFootprintProbe: FootprintProbe = {
  stat: pid => readOr(async () => parseProcStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8')), undefined),
  children: pid => readOr(() => procChildren(pid), []),
  tmpDir: pid => readOr(() => procTmpDir(pid), undefined),
  countFiles: (dir, cap) =>
    readOr(async () => {
      await fs.access(dir)
      return walkFiles(dir, cap)
    }, undefined),
}

interface TreeReading {
  cpuTicks: number
  rssKb: number
  children: number
}

export class FootprintSampler {
  private readonly tracked = new Map<string, Tracked>()
  private tick = 0

  constructor(
    private readonly probe: FootprintProbe = procFootprintProbe,
    private readonly maxPidsPerTick = MAX_PIDS_PER_TICK,
  ) {}

  /**
   * One pass. The start rotates, so a budget spent early does not starve the same agents every
   * tick. An agent no longer in `targets` is forgotten, so a row that ended without an exit row
   * cannot grow this map.
   */
  async sample(targets: readonly FootprintTarget[]): Promise<void> {
    const ids = new Set(targets.map(target => target.agentId))
    for (const agentId of this.tracked.keys()) if (!ids.has(agentId)) this.tracked.delete(agentId)
    const start = targets.length === 0 ? 0 : this.tick % targets.length
    this.tick += 1
    const budget = { pids: this.maxPidsPerTick }
    for (const target of [...targets.slice(start), ...targets.slice(0, start)]) {
      const state = this.stateOf(target.agentId)
      const reading = await this.readTree(target, state, budget)
      if (reading !== undefined) await this.record(target, state, reading)
    }
  }

  /** What was measured for this run so far; a later sample of the same run keeps accumulating. */
  peek(agentId: string): Footprint | undefined {
    const footprint = this.tracked.get(agentId)?.footprint
    return footprint === undefined || footprint.samples === 0 ? undefined : { ...footprint }
  }

  /** The run's footprint, ending its tracking: a resume starts a new run from zero. */
  take(agentId: string): Footprint | undefined {
    const footprint = this.peek(agentId)
    this.tracked.delete(agentId)
    return footprint
  }

  private stateOf(agentId: string): Tracked {
    const existing = this.tracked.get(agentId)
    if (existing !== undefined) return existing
    const state: Tracked = {
      footprint: { samples: 0, cpuSeconds: 0, rssPeakKb: 0, childrenPeak: 0 },
      roots: new Map(),
    }
    this.tracked.set(agentId, state)
    return state
  }

  private async ownRoot(pid: number, state: Tracked): Promise<ProcSample | undefined> {
    const stat = await this.probe.stat(pid)
    if (stat === undefined) return undefined
    const known = state.roots.get(pid)
    if (known !== undefined && known !== stat.startTicks) return undefined
    state.roots.set(pid, stat.startTicks)
    return stat
  }

  private async readTree(
    target: FootprintTarget,
    state: Tracked,
    budget: { pids: number },
  ): Promise<TreeReading | undefined> {
    const seen = new Set<number>()
    const pending: number[] = []
    const total: TreeReading = { cpuTicks: 0, rssKb: 0, children: 0 }
    for (const pid of target.rootPids) {
      const stat = await this.ownRoot(pid, state)
      if (stat === undefined || seen.has(pid)) continue
      seen.add(pid)
      pending.push(pid)
      add(total, stat)
      budget.pids -= 1
    }
    if (seen.size === 0) return undefined
    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
      for (const child of await this.probe.children(pid)) {
        if (seen.has(child) || seen.size >= MAX_PIDS_PER_AGENT || budget.pids <= 0) continue
        seen.add(child)
        budget.pids -= 1
        const stat = await this.probe.stat(child)
        if (stat === undefined) continue
        add(total, stat)
        total.children += 1
        pending.push(child)
      }
    }
    return total
  }

  private async record(target: FootprintTarget, state: Tracked, reading: TreeReading): Promise<void> {
    const { footprint } = state
    if (footprint.samples % TMP_SAMPLE_EVERY === 0) await this.recordTmp(target, state)
    footprint.samples += 1
    // A tree loses counters when a parent dies unreaped, so the peak is the honest total.
    footprint.cpuSeconds = Math.max(footprint.cpuSeconds, reading.cpuTicks / TICKS_PER_SECOND)
    footprint.rssPeakKb = Math.max(footprint.rssPeakKb, reading.rssKb)
    footprint.childrenPeak = Math.max(footprint.childrenPeak, reading.children)
  }

  private async recordTmp(target: FootprintTarget, state: Tracked): Promise<void> {
    const dir = state.tmpDir ?? (await this.findTmpDir(target))
    if (dir === undefined) return
    state.tmpDir = dir
    const files = await this.probe.countFiles(dir, MAX_TMP_FILES)
    if (files === undefined) return
    state.footprint.tmpFilesPeak = Math.max(state.footprint.tmpFilesPeak ?? 0, files)
  }

  private async findTmpDir(target: FootprintTarget): Promise<string | undefined> {
    for (const pid of target.rootPids) {
      const dir = await this.probe.tmpDir(pid)
      if (dir !== undefined) return dir
    }
    return undefined
  }
}

function add(total: TreeReading, stat: ProcSample): void {
  total.cpuTicks += stat.cpuTicks
  total.rssKb += stat.rssKb
}

export interface FootprintRoster {
  agents: () => readonly AgentIdentity[]
  launcherPid: (agentId: string) => number | undefined
  hostPid: (name: string) => number | undefined
  /** The agent runs on another machine, so its pids mean nothing here. */
  isRemote: (agent: AgentIdentity) => boolean
}

/** The local agents with a process to walk. An agent with neither pid is simply not sampled. */
export function footprintTargets(roster: FootprintRoster): FootprintTarget[] {
  return roster
    .agents()
    .filter(agent => LIVE_STATES.has(agent.state) && !roster.isRemote(agent))
    .flatMap(agent => {
      const rootPids = [roster.launcherPid(agent.agentId), roster.hostPid(agent.name)].filter(
        (pid): pid is number => pid !== undefined,
      )
      return rootPids.length === 0 ? [] : [{ agentId: agent.agentId, rootPids }]
    })
}

/** Ticks on an unref'd interval, never overlapping. A failed tick is dropped. Returns its cancel. */
export function startFootprintSampling(
  sampler: FootprintSampler,
  targets: () => FootprintTarget[],
  intervalMs = FOOTPRINT_INTERVAL_MS,
): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void Promise.resolve()
      .then(() => sampler.sample(targets()))
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** The `agent_exited` meta for a measured run; meta values are strings, so the numbers travel as JSON. */
export const footprintMeta = (footprint: Footprint | undefined): { footprint?: string } =>
  footprint === undefined
    ? {}
    : {
        footprint: JSON.stringify({ ...footprint, cpuSeconds: Math.round(footprint.cpuSeconds * 100) / 100 }),
      }

/** The footprint on an `agent_exited` row, for reporting and for the cost estimate. */
export function parseFootprintMeta(meta: Readonly<Record<string, string>>): Footprint | undefined {
  if (meta.footprint === undefined) return undefined
  try {
    const parsed = JSON.parse(meta.footprint) as Footprint
    const { samples, cpuSeconds, rssPeakKb, childrenPeak } = parsed
    return [samples, cpuSeconds, rssPeakKb, childrenPeak].every(Number.isFinite) ? parsed : undefined
  } catch {
    return undefined
  }
}
