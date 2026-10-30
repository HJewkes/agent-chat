import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  FootprintSampler,
  footprintMeta,
  footprintTargets,
  ownTmpDir,
  parseFootprintMeta,
  parseProcStat,
  procFootprintProbe,
  TMP_SAMPLE_EVERY,
  type FootprintProbe,
  type ProcSample,
} from '../agents/agent-footprint.js'
import type { AgentIdentity } from '../protocol.js'

interface FakeProc {
  ticks?: number
  rssKb?: number
  start?: number
  children?: number[]
}

function fakeProbe(
  procs: Map<number, FakeProc>,
  files: { dir?: string; count?: number } = {},
): FootprintProbe & { reads: number[] } {
  const reads: number[] = []
  return {
    reads,
    stat: async pid => {
      reads.push(pid)
      const proc = procs.get(pid)
      if (proc === undefined) return undefined
      const { ticks = 0, rssKb = 0, start = 1 } = proc
      return { ppid: 1, cpuTicks: ticks, rssKb, startTicks: start } satisfies ProcSample
    },
    children: async pid => procs.get(pid)?.children ?? [],
    tmpDir: async () => files.dir,
    countFiles: async () => files.count,
  }
}

const target = { agentId: 'a1', rootPids: [10] }

describe('reading /proc', () => {
  it('parses stat past a comm holding spaces and parentheses', () => {
    const rest = Array.from({ length: 49 }, (_, i) => i + 4).join(' ')

    expect(parseProcStat(`123 (a) b (c)) S ${rest}`)).toEqual({
      ppid: 4,
      cpuTicks: 14 + 15 + 16 + 17,
      rssKb: 24 * 4,
      startTicks: 22,
    })
  })

  it('reads garbage as no sample', () => {
    expect(parseProcStat('not a stat line')).toBeUndefined()
  })

  it('charges only a launch-owned TMPDIR', () => {
    expect(ownTmpDir({ TMPDIR: '/var/scratch/ac-x-12' })).toBe('/var/scratch/ac-x-12')
    expect(ownTmpDir({ TMPDIR: '/tmp' })).toBeUndefined()
    expect(ownTmpDir({})).toBeUndefined()
  })

  it('reads this process through the real probe', async () => {
    const stat = await procFootprintProbe.stat(process.pid)

    expect(stat?.cpuTicks).toBeGreaterThan(0)
    expect(stat?.rssKb).toBeGreaterThan(0)
    expect(await procFootprintProbe.stat(0)).toBeUndefined()
    expect(await procFootprintProbe.countFiles('/nonexistent-footprint-dir', 5)).toBeUndefined()
  })
})

describe('sampling a process tree', () => {
  it('sums the tree for CPU and RSS and counts children', async () => {
    const procs = new Map<number, FakeProc>([
      [10, { ticks: 100, rssKb: 1000, children: [20, 30] }],
      [20, { ticks: 50, rssKb: 500, children: [40] }],
      [30, { ticks: 25, rssKb: 250 }],
      [40, { ticks: 25, rssKb: 250 }],
    ])
    const sampler = new FootprintSampler(fakeProbe(procs))

    await sampler.sample([target])

    expect(sampler.take('a1')).toEqual({ samples: 1, cpuSeconds: 2, rssPeakKb: 2000, childrenPeak: 3 })
  })

  it('counts a process reached from both roots once', async () => {
    const procs = new Map<number, FakeProc>([
      [10, { ticks: 100, rssKb: 100, children: [20] }],
      [20, { ticks: 100, rssKb: 100 }],
    ])
    const sampler = new FootprintSampler(fakeProbe(procs))

    await sampler.sample([{ agentId: 'a1', rootPids: [10, 20] }])

    expect(sampler.peek('a1')).toMatchObject({ cpuSeconds: 2, rssPeakKb: 200 })
  })

  it('keeps the peaks after the tree shrinks', async () => {
    const procs = new Map<number, FakeProc>([
      [10, { ticks: 100, rssKb: 100, children: [20] }],
      [20, { ticks: 300, rssKb: 900 }],
    ])
    const sampler = new FootprintSampler(fakeProbe(procs))
    await sampler.sample([target])
    procs.set(10, { ticks: 120, rssKb: 100 })
    procs.delete(20)

    await sampler.sample([target])

    expect(sampler.take('a1')).toEqual({ samples: 2, cpuSeconds: 4, rssPeakKb: 1000, childrenPeak: 1 })
  })

  it('records nothing for an agent whose process could not be read', async () => {
    const sampler = new FootprintSampler(fakeProbe(new Map()))

    await sampler.sample([target])

    expect(sampler.take('a1')).toBeUndefined()
  })

  it('stops reading a root whose pid was recycled', async () => {
    const procs = new Map<number, FakeProc>([[10, { ticks: 100, rssKb: 100, start: 1 }]])
    const sampler = new FootprintSampler(fakeProbe(procs))
    await sampler.sample([target])
    procs.set(10, { ticks: 9000, rssKb: 9000, start: 2 })

    await sampler.sample([target])

    expect(sampler.take('a1')).toMatchObject({ samples: 1, cpuSeconds: 1 })
  })

  it('never reads past the pid budget of a tick', async () => {
    const pids = Array.from({ length: 50 }, (_, i) => 100 + i)
    const procs = new Map<number, FakeProc>([[10, { children: pids }], ...pids.map(p => [p, {}] as const)])
    const probe = fakeProbe(procs)
    const sampler = new FootprintSampler(probe, 5)

    await sampler.sample([target])

    expect(probe.reads).toHaveLength(5)
  })

  it('rotates the first agent so a spent budget does not starve the same one', async () => {
    const procs = new Map<number, FakeProc>([
      [10, { children: [11] }],
      [11, {}],
      [20, { children: [21] }],
      [21, {}],
    ])
    const sampler = new FootprintSampler(fakeProbe(procs), 2)
    const targets = [
      { agentId: 'a', rootPids: [10] },
      { agentId: 'b', rootPids: [20] },
    ]

    await sampler.sample(targets)
    await sampler.sample(targets)

    expect(sampler.peek('a')?.childrenPeak).toBe(1)
    expect(sampler.peek('b')?.childrenPeak).toBe(1)
  })

  it('forgets an agent that left the targets', async () => {
    const procs = new Map<number, FakeProc>([[10, { ticks: 100 }]])
    const sampler = new FootprintSampler(fakeProbe(procs))
    await sampler.sample([target])

    await sampler.sample([])

    expect(sampler.peek('a1')).toBeUndefined()
  })

  it('counts TMPDIR files on the first sample and every Nth after, keeping the peak', async () => {
    const procs = new Map<number, FakeProc>([[10, {}]])
    const files = { dir: '/x/ac-a-1', count: 7 }
    const sampler = new FootprintSampler(fakeProbe(procs, files))
    await sampler.sample([target])
    files.count = 3

    for (let i = 0; i < TMP_SAMPLE_EVERY; i += 1) await sampler.sample([target])

    expect(sampler.peek('a1')?.tmpFilesPeak).toBe(7)
  })

  it('leaves tmp files out when no TMPDIR was read', async () => {
    const procs = new Map<number, FakeProc>([[10, {}]])
    const sampler = new FootprintSampler(fakeProbe(procs))

    await sampler.sample([target])

    expect(sampler.peek('a1')).not.toHaveProperty('tmpFilesPeak')
  })

  it('walks a real child of this process', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      const sampler = new FootprintSampler(procFootprintProbe)

      await sampler.sample([{ agentId: 'real', rootPids: [process.pid] }])

      expect(await procFootprintProbe.children(process.pid)).toContain(child.pid)
      expect(sampler.peek('real')?.childrenPeak).toBeGreaterThan(0)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('stops a real file count at the cap', async () => {
    expect(await procFootprintProbe.countFiles('/proc/self', 3)).toBe(3)
  })
})

describe('choosing targets', () => {
  const agent = (over: Partial<AgentIdentity>): AgentIdentity =>
    ({ agentId: 'a1', name: 'n1', state: 'live', ...over }) as AgentIdentity
  const roster = (agents: AgentIdentity[], over = {}) => ({
    agents: () => agents,
    launcherPid: () => 10,
    hostPid: () => 20,
    isRemote: () => false,
    ...over,
  })

  it('takes both pids of a live local agent', () => {
    expect(footprintTargets(roster([agent({})]))).toEqual([{ agentId: 'a1', rootPids: [10, 20] }])
  })

  it('skips finished, remote and pidless agents', () => {
    expect(footprintTargets(roster([agent({ state: 'exited' })]))).toEqual([])
    expect(footprintTargets(roster([agent({})], { isRemote: () => true }))).toEqual([])
    expect(
      footprintTargets(roster([agent({})], { launcherPid: () => undefined, hostPid: () => undefined })),
    ).toEqual([])
  })
})

describe('the exit row', () => {
  it('round-trips a footprint through meta', () => {
    const footprint = { samples: 3, cpuSeconds: 1.239, rssPeakKb: 10, childrenPeak: 2, tmpFilesPeak: 4 }

    expect(parseFootprintMeta(footprintMeta(footprint) as Record<string, string>)).toEqual({
      ...footprint,
      cpuSeconds: 1.24,
    })
  })

  it('writes nothing for an unmeasured run and reads nothing from a bad one', () => {
    expect(footprintMeta(undefined)).toEqual({})
    expect(parseFootprintMeta({})).toBeUndefined()
    expect(parseFootprintMeta({ footprint: '{' })).toBeUndefined()
    expect(parseFootprintMeta({ footprint: '{"samples":"x"}' })).toBeUndefined()
  })
})
