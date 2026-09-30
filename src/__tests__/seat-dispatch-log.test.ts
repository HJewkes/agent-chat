import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seatDispatchLog, type SeatDispatchLog, type SpawnFacts } from '../agents/seats/dispatch-log.js'
import { foldDispatch } from '../agents/seats/dispatch-record.js'

/**
 * CC-330: the broker's writer of a seat's dispatch log. Every seat, prefix, task id and initiative here is
 * synthetic, and the autonomy and active-work roots are temp directories.
 */

const AGENT = 'sx-ab-12-fix'
const AT = new Date('2026-02-03T04:05:00Z')

const tmpDirs: string[] = []
let root: string
let activeWork: string
let logged: string[]

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const seatFile = (seat: string, fields: string): void =>
  fs.writeFileSync(path.join(root, 'seats', `${seat}.md`), `---\n${fields}\n---\n`)

const plainSeat = (seat: string, prefix: string): void => seatFile(seat, `prefix: ${prefix}\npool: pool-a`)

const writerOver = (dir = root): SeatDispatchLog =>
  seatDispatchLog(dir, { now: () => AT, activeWork, log: event => void logged.push(event) })

const facts = (over: Partial<SpawnFacts> = {}): SpawnFacts => ({
  profile: 'implementer',
  agent: AGENT,
  agent_id: 'id-1',
  spawner: 'seat-x',
  model: 'model-a',
  predecessor: null,
  ...over,
})

const logFile = (seat: string): string => path.join(root, 'logs', seat, 'dispatch.jsonl')

const rowsOf = (file: string): Record<string, unknown>[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : []

const taskFile = (slug: string, id: string, tags: string): void => {
  fs.mkdirSync(path.join(activeWork, slug, 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(activeWork, slug, 'tasks', `${id}.yml`),
    `id: ${id}\ntitle: A task\ntags: ${tags}\n`,
  )
}

beforeEach(() => {
  root = tmp('dispatch-root-')
  activeWork = tmp('dispatch-aw-')
  fs.mkdirSync(path.join(root, 'seats'))
  plainSeat('seat-x', 'sx')
  logged = []
})

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the rows the writer appends', () => {
  it('writes a dispatched row with every key, the time and the task from the name', () => {
    writerOver().dispatched(facts())

    const [row] = rowsOf(logFile('seat-x'))
    expect(row).toMatchObject({
      ts: AT.toISOString(),
      task: 'AB-12',
      agent: AGENT,
      outcome: 'dispatched',
      by: 'broker',
      agent_id: 'id-1',
      spawner: 'seat-x',
    })
    expect(logged).toEqual([])
  })

  it('writes a retired row with the session and spend, which folds with the dispatched row into one record', () => {
    const writer = writerOver()
    const usage = { input: 10, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 5 }

    writer.dispatched(facts())
    writer.retired(facts(), 'session-1', {
      tokens: 15,
      usd_est: 0.01,
      usage,
      models: ['model-a'],
      price_table: 1,
    })

    const rows = rowsOf(logFile('seat-x'))
    expect(rows[1]).toMatchObject({ outcome: 'retired', session_id: 'session-1', tokens: 15 })
    const fold = foldDispatch(fs.readFileSync(logFile('seat-x'), 'utf8'))
    expect(fold.records).toHaveLength(1)
    expect(fold.records[0]).toMatchObject({ outcome: 'retired', tokens: 15 })
  })

  it('records a seat-prefixed agent spawned by a non-seat session in that seat’s log, naming the spawner', () => {
    writerOver().dispatched(facts({ spawner: 'human' }))

    expect(rowsOf(logFile('seat-x'))[0]).toMatchObject({ agent: AGENT, spawner: 'human' })
  })

  it('writes nothing for an agent whose name carries no seat prefix', () => {
    writerOver().dispatched(facts({ agent: 'other-ab-12-fix' }))

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
    expect(logged).toEqual([])
  })
})

describe('task, initiative and kind', () => {
  it('takes the initiative and kind tag from the task file when one exists', () => {
    taskFile('demo', 'AB-12', '[kind:agent-tooling, other]')

    writerOver().dispatched(facts())

    expect(rowsOf(logFile('seat-x'))[0]).toMatchObject({
      task: 'AB-12',
      initiative: 'demo',
      kind: 'agent-tooling',
    })
  })

  it('keeps the parsed task with null initiative and kind when no task file exists', () => {
    taskFile('demo', 'CD-34', '[kind:agent-tooling]')

    writerOver().dispatched(facts())

    expect(rowsOf(logFile('seat-x'))[0]).toMatchObject({ task: 'AB-12', initiative: null, kind: null })
  })

  it('gives a null kind for a task file with no kind tag', () => {
    taskFile('demo', 'AB-12', '[other]')

    writerOver().dispatched(facts())

    expect(rowsOf(logFile('seat-x'))[0]).toMatchObject({ initiative: 'demo', kind: null })
  })

  it('takes the first initiative by name when two hold the same task id', () => {
    taskFile('zeta', 'AB-12', '[kind:second]')
    taskFile('alpha', 'AB-12', '[kind:first]')

    writerOver().dispatched(facts())

    expect(rowsOf(logFile('seat-x'))[0]).toMatchObject({ initiative: 'alpha', kind: 'first' })
  })

  it('writes a null task for a name with no task id', () => {
    writerOver().dispatched(facts({ agent: 'sx-restart-check' }))

    expect(rowsOf(logFile('seat-x'))[0]).toMatchObject({ task: null, initiative: null, kind: null })
  })
})

describe('which seat owns the agent', () => {
  it('picks the seat with the longest matching prefix, not the first seat file', () => {
    plainSeat('seat-z', 'sx-q')

    writerOver().dispatched(facts({ agent: 'sx-q-ab-12-fix' }))

    expect(rowsOf(logFile('seat-z'))[0]).toMatchObject({ agent: 'sx-q-ab-12-fix', task: 'AB-12' })
    expect(fs.existsSync(logFile('seat-x'))).toBe(false)
  })

  it('settles a prefix two seats share by the spawner’s name, not the directory order', () => {
    plainSeat('seat-a', 'sx')

    writerOver().dispatched(facts({ spawner: 'seat-x' }))

    expect(rowsOf(logFile('seat-x'))).toHaveLength(1)
    expect(fs.existsSync(logFile('seat-a'))).toBe(false)
  })

  it('writes nothing for a shared prefix no spawner settles, and logs it once', () => {
    plainSeat('seat-a', 'sx')
    const writer = writerOver()

    writer.dispatched(facts({ spawner: 'human' }))
    writer.retired(facts({ spawner: 'human' }), null, { usage_miss: 'no transcript' })

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
    expect(logged).toEqual(['seat_dispatch_ambiguous'])
  })

  it.each([
    ['with no read permission', (file: string) => fs.chmodSync(file, 0o000)],
    ['that is a directory', (file: string) => (fs.rmSync(file), fs.mkdirSync(file))],
  ])('skips a seat file %s, writes nothing and logs it once', (_, spoil) => {
    spoil(path.join(root, 'seats', 'seat-x.md'))
    const writer = writerOver()

    writer.dispatched(facts())
    writer.dispatched(facts())

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
    expect(logged).toEqual(['seat_dispatch_seat_unreadable'])
  })

  it('ignores a seat file without a prefix', () => {
    seatFile('seat-x', 'pool: pool-a')

    expect(() => writerOver().dispatched(facts())).not.toThrow()

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
  })
})

describe('where the rows go', () => {
  it('writes to the seat’s dispatch_log under the root', () => {
    seatFile('seat-x', 'prefix: sx\npool: pool-a\ndispatch_log: records/sx.jsonl')

    writerOver().dispatched(facts())

    expect(rowsOf(path.join(root, 'records', 'sx.jsonl'))).toHaveLength(1)
  })

  it.each([
    ['a relative', (outside: string) => path.relative(root, path.join(outside, 'escaped.jsonl'))],
    ['an absolute', (outside: string) => path.join(outside, 'escaped.jsonl')],
  ])('refuses %s dispatch_log that resolves outside the root, and logs it once', (_, declaredIn) => {
    const outside = tmp('dispatch-outside-')
    seatFile('seat-x', `prefix: sx\npool: pool-a\ndispatch_log: ${declaredIn(outside)}`)
    const writer = writerOver()

    writer.dispatched(facts())
    writer.dispatched(facts())

    expect(fs.readdirSync(outside)).toEqual([])
    expect(logged).toEqual(['seat_dispatch_refused'])
  })

  it('writes a newline before the row when the last line has none', () => {
    fs.mkdirSync(path.dirname(logFile('seat-x')), { recursive: true })
    fs.writeFileSync(logFile('seat-x'), '{"agent":"sx-cd-34-fix","outcome":"done"}')

    writerOver().dispatched(facts())

    const lines = fs.readFileSync(logFile('seat-x'), 'utf8').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('{"agent":"sx-cd-34-fix","outcome":"done"}')
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ agent: AGENT })
  })

  it('writes the first row of an empty existing log with no newline before it', () => {
    fs.mkdirSync(path.dirname(logFile('seat-x')), { recursive: true })
    fs.writeFileSync(logFile('seat-x'), '')

    writerOver().dispatched(facts())

    const text = fs.readFileSync(logFile('seat-x'), 'utf8')
    expect(text.split('\n')).toHaveLength(2)
    expect(JSON.parse(text)).toMatchObject({ agent: AGENT })
  })
})

describe('a symlink under the root', () => {
  const declare = (dispatchLog: string): void =>
    seatFile('seat-x', `prefix: sx\npool: pool-a\ndispatch_log: ${dispatchLog}`)

  const writeTwice = (): void => {
    const writer = writerOver()
    writer.dispatched(facts())
    writer.dispatched(facts())
  }

  it('refuses a dispatch_log under a directory symlink that points outside, and logs it once', () => {
    const outside = tmp('dispatch-outside-')
    fs.symlinkSync(outside, path.join(root, 'links'))
    declare('links/x.jsonl')

    writeTwice()

    expect(fs.readdirSync(outside)).toEqual([])
    expect(logged).toEqual(['seat_dispatch_refused'])
  })

  it('creates no directory outside for a missing path under such a symlink', () => {
    const outside = tmp('dispatch-outside-')
    fs.symlinkSync(outside, path.join(root, 'links'))
    declare('links/new/sub/x.jsonl')

    writeTwice()

    expect(fs.readdirSync(outside)).toEqual([])
    expect(logged).toEqual(['seat_dispatch_refused'])
  })

  it('refuses the default path when logs/ is a symlink that points outside', () => {
    const outside = tmp('dispatch-outside-')
    fs.symlinkSync(outside, path.join(root, 'logs'))

    writeTwice()

    expect(fs.readdirSync(outside)).toEqual([])
    expect(logged).toEqual(['seat_dispatch_refused'])
  })

  it('does not append through a log file that is a symlink to a file outside', () => {
    const target = path.join(tmp('dispatch-outside-'), 'victim.jsonl')
    fs.writeFileSync(target, 'untouched\n')
    fs.mkdirSync(path.dirname(logFile('seat-x')), { recursive: true })
    fs.symlinkSync(target, logFile('seat-x'))

    writeTwice()

    expect(fs.readFileSync(target, 'utf8')).toBe('untouched\n')
    expect(logged).toEqual(['seat_dispatch_refused'])
  })

  it('writes through a directory symlink that points to a place inside the root', () => {
    fs.mkdirSync(path.join(root, 'archive'))
    fs.symlinkSync(path.join(root, 'archive'), path.join(root, 'logs'))

    writerOver().dispatched(facts())

    expect(rowsOf(path.join(root, 'archive', 'seat-x', 'dispatch.jsonl'))).toHaveLength(1)
    expect(logged).toEqual([])
  })

  it('refuses a log file that is a symlink even when it points inside the root', () => {
    const target = path.join(root, 'real.jsonl')
    fs.writeFileSync(target, '')
    fs.mkdirSync(path.dirname(logFile('seat-x')), { recursive: true })
    fs.symlinkSync(target, logFile('seat-x'))

    writerOver().dispatched(facts())

    expect(fs.readFileSync(target, 'utf8')).toBe('')
    expect(logged).toEqual(['seat_dispatch_refused'])
  })
})

describe('a log path that is not the regular file it was opened as', () => {
  const declare = (dispatchLog: string): void =>
    seatFile('seat-x', `prefix: sx\npool: pool-a\ndispatch_log: ${dispatchLog}`)

  it('refuses a FIFO at the log path without blocking, and logs it once', () => {
    declare('pipe.jsonl')
    execFileSync('mkfifo', [path.join(root, 'pipe.jsonl')])
    const writer = writerOver()

    writer.dispatched(facts())
    writer.dispatched(facts())

    expect(logged).toEqual(['seat_dispatch_refused'])
  })

  it('refuses a dispatch_log under a dangling directory symlink, not as unavailable', () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'links'))
    declare('links/x.jsonl')

    writerOver().dispatched(facts())

    expect(logged).toEqual(['seat_dispatch_refused'])
    expect(fs.existsSync(path.join(root, 'nowhere'))).toBe(false)
  })

  it('refuses a socket at the log path, not as unavailable', async () => {
    declare('sock.jsonl')
    const server = net.createServer()
    await new Promise<void>(done => server.listen(path.join(root, 'sock.jsonl'), done))

    try {
      writerOver().dispatched(facts())
    } finally {
      await new Promise(done => server.close(done))
    }

    expect(logged).toEqual(['seat_dispatch_refused'])
  })

  it('refuses when a directory is swapped for a symlink outside just before the open', () => {
    const outside = tmp('dispatch-outside-')
    declare('d/x.jsonl')
    fs.mkdirSync(path.join(root, 'd'))
    const realOpen = fs.openSync
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      spy.mockRestore()
      fs.renameSync(path.join(root, 'd'), path.join(root, 'd.moved'))
      fs.symlinkSync(outside, path.join(root, 'd'))
      return realOpen(...args)
    }) as typeof fs.openSync)

    writerOver().dispatched(facts())

    expect(logged).toEqual(['seat_dispatch_refused'])
    expect(rowsOf(path.join(outside, 'x.jsonl'))).toEqual([])
  })

  it('refuses when the opened file is not the one its path now names, appending nothing', () => {
    const swapped = (file: string): fs.Stats => {
      const real = fs.statSync(file)
      return Object.assign(Object.create(real) as fs.Stats, { ino: real.ino + 1 })
    }
    const writer = seatDispatchLog(root, {
      now: () => AT,
      activeWork,
      log: e => void logged.push(e),
      stat: swapped,
    })

    writer.dispatched(facts())

    expect(logged).toEqual(['seat_dispatch_refused'])
    expect(rowsOf(logFile('seat-x'))).toEqual([])
  })
})

describe('an autonomy root the writer cannot use', () => {
  it('writes nothing for a missing root, never creates it, does not throw and logs once', () => {
    const missing = path.join(tmp('dispatch-none-'), 'absent')
    const writer = writerOver(missing)

    expect(() => {
      writer.dispatched(facts())
      writer.retired(facts(), null, { usage_miss: 'no transcript' })
    }).not.toThrow()

    expect(fs.existsSync(missing)).toBe(false)
    expect(logged).toEqual(['seat_dispatch_unavailable'])
  })

  it('writes nothing to a read-only log file, does not throw and logs once', () => {
    fs.mkdirSync(path.dirname(logFile('seat-x')), { recursive: true })
    fs.writeFileSync(logFile('seat-x'), '')
    fs.chmodSync(logFile('seat-x'), 0o444)
    const writer = writerOver()

    expect(() => {
      writer.dispatched(facts())
      writer.dispatched(facts())
    }).not.toThrow()

    expect(fs.readFileSync(logFile('seat-x'), 'utf8')).toBe('')
    expect(logged).toEqual(['seat_dispatch_unavailable'])
  })
})

describe('a seat appending by shell while the writer appends', () => {
  it('leaves every one of 400 interleaved lines parseable', async () => {
    const file = logFile('seat-x')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = `{"agent":"${AGENT}","outcome":"done","note":"by shell"}`
    const shell = spawn('/bin/sh', [
      '-c',
      `i=0; while [ $i -lt 200 ]; do i=$((i+1)); echo '${line}' >> "$1"; done`,
      'sh',
      file,
    ])
    const exited = new Promise(resolve => shell.on('exit', resolve))
    const writer = writerOver()

    for (let i = 0; i < 200; i++) {
      writer.dispatched(facts({ agent_id: `id-${i}` }))
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(await exited).toBe(0)

    const lines = fs.readFileSync(file, 'utf8').split('\n')
    expect(lines.pop()).toBe('')
    expect(lines).toHaveLength(400)
    for (const text of lines) expect(() => JSON.parse(text) as unknown).not.toThrow()
    expect(logged).toEqual([])
  })
})
