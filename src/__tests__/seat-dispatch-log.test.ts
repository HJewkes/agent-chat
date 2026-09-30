import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
