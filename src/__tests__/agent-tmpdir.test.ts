import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../protocol.js'
import { agentEnv } from '../agents/agent-env.js'
import {
  agentTmpPath,
  ensureAgentTmpDir,
  removeAgentTmpDir,
  removeOwnTmpDir,
  sweepAgentTmpDirs,
  type TmpFs,
  type TmpProcessTable,
  type TmpStat,
} from '../agents/agent-tmpdir.js'
import { SWEEP_GRACE_MS } from '../agents/orphan-reap.js'

const UID = 1000

interface FakeNode {
  kind: 'dir' | 'file' | 'symlink'
  uid: number
  mode?: number
}

/** An in-memory fs keyed by absolute path; nothing touches the real /tmp. */
class FakeFs implements TmpFs {
  readonly removed: string[] = []
  readonly made: Array<[string, number]> = []
  constructor(readonly nodes = new Map<string, FakeNode>([['/tmp', { kind: 'dir', uid: 0 }]])) {}

  add(path: string, kind: FakeNode['kind'] = 'dir', uid = UID): this {
    this.nodes.set(path, { kind, uid })
    return this
  }
  lstat(path: string): TmpStat | undefined {
    const node = this.nodes.get(path)
    if (node === undefined) return undefined
    return {
      uid: node.uid,
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => node.kind === 'symlink',
    }
  }
  readdir(path: string): string[] {
    return [...this.nodes.keys()]
      .filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
      .map(p => p.slice(path.length + 1))
  }
  mkdir(path: string, mode: number): void {
    if (this.nodes.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    this.made.push([path, mode])
    this.nodes.set(path, { kind: 'dir', uid: UID, mode })
  }
  chmod(path: string, mode: number): void {
    const node = this.nodes.get(path)
    if (node !== undefined) node.mode = mode
  }
  rm(path: string): void {
    this.removed.push(path)
    for (const p of [...this.nodes.keys()]) if (p === path || p.startsWith(`${path}/`)) this.nodes.delete(p)
  }
}

interface FakeProc {
  env?: Record<string, string>
  command?: string
  ppid?: number
  cwd?: string
  fds?: string[]
}

const procTable = (entries: Record<number, FakeProc>): TmpProcessTable => {
  const procs = new Map(Object.entries(entries).map(([pid, p]) => [Number(pid), p]))
  return {
    pids: () => [...procs.keys()],
    environ: pid => procs.get(pid)?.env,
    command: pid => procs.get(pid)?.command ?? '',
    parentOf: pid => procs.get(pid)?.ppid,
    isAlive: pid => procs.has(pid),
    cwd: pid => procs.get(pid)?.cwd,
    fds: pid => procs.get(pid)?.fds ?? [],
  }
}

const launch = (agentId: string, launcher: number) => ({
  AGENT_CHAT_AGENT_ID: agentId,
  AGENT_CHAT_NAME: 'worker',
  AGENT_CHAT_LAUNCHER_PID: String(launcher),
})

const DIR = '/tmp/ac-worker-4242'
const target = { name: 'worker', pid: 4242, agentIds: new Set(['a1']) }
const deps = (fs: FakeFs, table = procTable({})) => ({ fs, table, uid: UID, self: 1 })

describe('the per-agent tmp path', () => {
  it('is /tmp/ac-<name>-<pid>', () => {
    expect(agentTmpPath('worker', 4242)).toBe(DIR)
  })

  it('refuses a name that could leave /tmp or widen the match', () => {
    for (const name of [
      '',
      '.',
      '..',
      '../etc',
      'a/b',
      'a\\b',
      '*',
      'a b',
      'x\nb',
      '-lead',
      'a'.repeat(65),
    ]) {
      expect(agentTmpPath(name, 4242), JSON.stringify(name)).toBeUndefined()
    }
  })

  it('refuses a pid that is not a positive integer', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(agentTmpPath('worker', pid), String(pid)).toBeUndefined()
    }
  })
})

describe('making the per-agent TMPDIR', () => {
  it('creates the dir 0700 on Linux', () => {
    const fs = new FakeFs()

    expect(ensureAgentTmpDir({ name: 'worker', pid: 4242, platform: 'linux', fs, uid: UID })).toBe(DIR)
    expect(fs.made).toEqual([[DIR, 0o700]])
  })

  it('makes nothing on macOS', () => {
    const fs = new FakeFs()

    expect(ensureAgentTmpDir({ name: 'worker', pid: 4242, platform: 'darwin', fs, uid: UID })).toBeUndefined()
    expect(fs.made).toEqual([])
  })

  it('reuses a leftover dir it owns and tightens it to 0700', () => {
    const fs = new FakeFs().add(DIR)

    expect(ensureAgentTmpDir({ name: 'worker', pid: 4242, platform: 'linux', fs, uid: UID })).toBe(DIR)
    expect(fs.nodes.get(DIR)?.mode).toBe(0o700)
  })

  it('will not adopt a planted symlink or another user’s dir', () => {
    const link = new FakeFs().add(DIR, 'symlink')
    const foreign = new FakeFs().add(DIR, 'dir', 0)

    expect(
      ensureAgentTmpDir({ name: 'worker', pid: 4242, platform: 'linux', fs: link, uid: UID }),
    ).toBeUndefined()
    expect(
      ensureAgentTmpDir({ name: 'worker', pid: 4242, platform: 'linux', fs: foreign, uid: UID }),
    ).toBeUndefined()
  })

  it('makes nothing for an invalid name', () => {
    const fs = new FakeFs()

    expect(ensureAgentTmpDir({ name: '../etc', pid: 4242, platform: 'linux', fs, uid: UID })).toBeUndefined()
    expect(fs.made).toEqual([])
  })
})

describe('agentEnv with an agent launch', () => {
  const linux = (fs: FakeFs) => ({ name: 'worker', pid: 4242, platform: 'linux' as const, fs, uid: UID })

  it('gives TMPDIR, TMP and TEMP the per-agent dir on Linux when the parent has /tmp', () => {
    const env = agentEnv({ HOME: '/home/example', TMPDIR: '/tmp' }, { agentTmp: linux(new FakeFs()) })

    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([DIR, DIR, DIR])
  })

  it('gives the per-agent dir when the parent has no TMPDIR', () => {
    const env = agentEnv({ HOME: '/home/example' }, { agentTmp: linux(new FakeFs()), tmpDir: () => '/tmp' })

    expect(env.TMPDIR).toBe(DIR)
  })

  it('keeps a TMPDIR the parent pointed somewhere other than /tmp', () => {
    const fs = new FakeFs()
    const env = agentEnv({ HOME: '/home/example', TMPDIR: '/home/example/.cache/rounds' }, { agentTmp: linux(fs) })

    expect(env.TMPDIR).toBe('/home/example/.cache/rounds')
    expect(fs.made).toEqual([])
  })

  it('keeps the macOS user temp dir', () => {
    const fs = new FakeFs()
    const env = agentEnv(
      { HOME: '/Users/example' },
      { agentTmp: { ...linux(fs), platform: 'darwin' }, tmpDir: () => '/var/folders/xx/T/' },
    )

    expect(env.TMPDIR).toBe('/var/folders/xx/T/')
    expect(env.TMP).toBeUndefined()
    expect(fs.made).toEqual([])
  })

  it('falls back to /tmp when the dir cannot be made', () => {
    const env = agentEnv({ TMPDIR: '/tmp' }, { agentTmp: linux(new FakeFs().add(DIR, 'symlink')) })

    expect(env.TMPDIR).toBe('/tmp')
  })
})

describe('removing a per-agent TMPDIR', () => {
  it('removes the dir and counts every inode in it', () => {
    const fs = new FakeFs()
      .add(DIR)
      .add(`${DIR}/a.txt`, 'file')
      .add(`${DIR}/sub`)
      .add(`${DIR}/sub/b.txt`, 'file')
      .add(`${DIR}/link`, 'symlink')

    expect(removeAgentTmpDir(target, deps(fs))).toEqual({ removed: true, path: DIR, inodes: 5 })
    expect(fs.removed).toEqual([DIR])
  })

  it('treats a missing dir as nothing to do', () => {
    const fs = new FakeFs()

    expect(removeAgentTmpDir(target, deps(fs))).toEqual({ removed: false, path: DIR, reason: 'missing' })
    expect(fs.removed).toEqual([])
  })

  it('refuses a symlink', () => {
    const fs = new FakeFs().add(DIR, 'symlink')

    expect(removeAgentTmpDir(target, deps(fs))).toMatchObject({ removed: false, reason: 'symlink' })
    expect(fs.removed).toEqual([])
  })

  it('refuses something that is not a directory', () => {
    const fs = new FakeFs().add(DIR, 'file')

    expect(removeAgentTmpDir(target, deps(fs))).toMatchObject({ removed: false, reason: 'not a directory' })
    expect(fs.removed).toEqual([])
  })

  it('refuses a dir another user owns', () => {
    const fs = new FakeFs().add(DIR, 'dir', 0)

    expect(removeAgentTmpDir(target, deps(fs))).toMatchObject({ removed: false, reason: 'owned by uid 0' })
    expect(fs.removed).toEqual([])
  })

  it('refuses an invalid name or pid without looking at the fs', () => {
    const fs = new FakeFs().add('/etc')

    expect(removeAgentTmpDir({ ...target, name: '../../etc' }, deps(fs))).toMatchObject({
      removed: false,
      reason: 'invalid name or pid',
    })
    expect(removeAgentTmpDir({ ...target, pid: 0 }, deps(fs))).toMatchObject({ removed: false })
    expect(fs.removed).toEqual([])
  })

  it('keeps the dir while a live process has its cwd inside it', () => {
    const fs = new FakeFs().add(DIR).add(`${DIR}/work`)
    const table = procTable({ 900: { cwd: `${DIR}/work` } })

    expect(removeAgentTmpDir(target, deps(fs, table))).toMatchObject({
      removed: false,
      reason: 'in use by pid 900',
    })
    expect(fs.removed).toEqual([])
  })

  it('keeps the dir while a live process holds an open fd inside it', () => {
    const fs = new FakeFs().add(DIR)
    const table = procTable({ 901: { cwd: '/home/example', fds: ['/dev/null', `${DIR}/log (deleted)`] } })

    expect(removeAgentTmpDir(target, deps(fs, table))).toMatchObject({
      removed: false,
      reason: 'in use by pid 901',
    })
    expect(fs.removed).toEqual([])
  })

  it('does not mistake a sibling dir sharing the prefix for the agent’s own', () => {
    const fs = new FakeFs().add(DIR)
    const table = procTable({ 902: { cwd: `${DIR}5` } })

    expect(removeAgentTmpDir(target, deps(fs, table))).toMatchObject({ removed: true })
  })

  it('keeps the dir while a process of that launch is still alive', () => {
    const fs = new FakeFs().add(DIR)
    const table = procTable({ 903: { env: launch('a1', 4242), cwd: '/home/example' } })

    expect(removeAgentTmpDir(target, deps(fs, table))).toMatchObject({
      removed: false,
      reason: 'launch process 903 alive',
    })
  })

  it('ignores its own process and ancestors when judging liveness', () => {
    const fs = new FakeFs().add(DIR)
    const table = procTable({ 4242: { env: launch('a1', 4242), cwd: '/home/example', ppid: 1 } })

    expect(removeAgentTmpDir(target, { ...deps(fs, table), self: 4242 })).toMatchObject({ removed: true })
  })
})

describe('removing the TMPDIR at run-agent exit', () => {
  it('removes the launch’s own dir and logs the inode count', () => {
    const fs = new FakeFs().add(DIR).add(`${DIR}/x`, 'file')
    const events: Array<[string, Record<string, unknown>]> = []

    removeOwnTmpDir('worker', 'a1', 4242, {
      ...deps(fs),
      self: 4242,
      platform: 'linux',
      log: (e, d) => events.push([e, d]),
    })

    expect(events).toEqual([['tmpdir_removed', { source: 'exit', agentId: 'a1', path: DIR, inodes: 2 }]])
  })

  it('logs why it kept the dir', () => {
    const fs = new FakeFs().add(DIR)
    const events: Array<[string, Record<string, unknown>]> = []

    removeOwnTmpDir('worker', 'a1', 4242, {
      ...deps(fs, procTable({ 77: { env: launch('a1', 4242) } })),
      self: 4242,
      platform: 'linux',
      log: (e, d) => events.push([e, d]),
    })

    expect(events).toEqual([
      ['tmpdir_kept', { source: 'exit', agentId: 'a1', path: DIR, reason: 'launch process 77 alive' }],
    ])
    expect(fs.removed).toEqual([])
  })

  it('does nothing off Linux', () => {
    const fs = new FakeFs().add(DIR)
    const events: unknown[] = []

    removeOwnTmpDir('worker', 'a1', 4242, { ...deps(fs), platform: 'darwin', log: e => events.push(e) })

    expect(fs.removed).toEqual([])
    expect(events).toEqual([])
  })
})

const row = (agentId: string, name: string, state: AgentIdentity['state'], exitedAt = 0): AgentIdentity =>
  ({ agentId, name, state, exitedAt, lastEventAt: exitedAt }) as AgentIdentity

describe('sweeping per-agent TMPDIRs of finished agents', () => {
  const now = SWEEP_GRACE_MS + 1
  const run = (fs: FakeFs, roster: AgentIdentity[], table = procTable({})) => {
    const events: Array<[string, Record<string, unknown>]> = []
    sweepAgentTmpDirs({
      roster: () => roster,
      now: () => now,
      ...deps(fs, table),
      log: (e, d) => events.push([e, d]),
    })
    return events
  }

  it('removes the dirs of an exited agent and logs each', () => {
    const fs = new FakeFs()
      .add('/tmp/ac-worker-11')
      .add('/tmp/ac-worker-12')
      .add('/tmp/ac-worker-12/f', 'file')

    const events = run(fs, [row('a1', 'worker', 'exited')])

    expect(fs.removed.sort()).toEqual(['/tmp/ac-worker-11', '/tmp/ac-worker-12'])
    expect(events).toContainEqual([
      'tmpdir_removed',
      { source: 'sweep', agentId: 'a1', path: '/tmp/ac-worker-12', inodes: 2 },
    ])
  })

  it('leaves every entry that is not exactly ac-<finished name>-<pid>', () => {
    const fs = new FakeFs()
      .add('/tmp/ac-worker-abc')
      .add('/tmp/ac-worker-')
      .add('/tmp/ac-worker-0')
      .add('/tmp/ac-other-11')
      .add('/tmp/ac-worker')
      .add('/tmp/review-500-abc')
      .add('/tmp/worker-11')

    run(fs, [row('a1', 'worker', 'exited')])

    expect(fs.removed).toEqual([])
  })

  it('leaves a name that also has a live row', () => {
    const fs = new FakeFs().add('/tmp/ac-worker-11')

    run(fs, [row('a1', 'worker', 'exited'), row('a2', 'worker', 'live')])

    expect(fs.removed).toEqual([])
  })

  it('leaves an agent still inside the sweep grace', () => {
    const fs = new FakeFs().add('/tmp/ac-worker-11')

    run(fs, [row('a1', 'worker', 'exited', now)])

    expect(fs.removed).toEqual([])
  })

  it('leaves a dir whose launcher is still a live run-agent of that agent', () => {
    const fs = new FakeFs().add('/tmp/ac-worker-11')

    run(fs, [row('a1', 'worker', 'retired')], procTable({ 11: { command: 'node agent-chat run-agent a1' } }))

    expect(fs.removed).toEqual([])
  })

  it('refuses a symlink and reports it once, not every sweep', () => {
    const fs = new FakeFs().add('/tmp/ac-worker-11', 'symlink')
    const roster = [row('a1', 'worker', 'exited')]
    const events: string[] = []
    const sweep = {
      roster: () => roster,
      now: () => now,
      ...deps(fs),
      log: (e: string) => events.push(e),
      announced: new Set<string>(),
    }

    sweepAgentTmpDirs(sweep)
    sweepAgentTmpDirs(sweep)

    expect(fs.removed).toEqual([])
    expect(events).toEqual(['tmpdir_kept'])
  })

  it('does nothing when no agent is finished', () => {
    const fs = new FakeFs().add('/tmp/ac-worker-11')

    expect(run(fs, [row('a1', 'worker', 'live')])).toEqual([])
    expect(fs.removed).toEqual([])
  })
})
