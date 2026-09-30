import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, CLOSING_ACT_MS, type Conn } from '../broker/core.js'
import { deliver, SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { MAX_REMEMBERED, ReportBatcher } from '../broker/report-batch.js'
import { batchMeta } from '../server/index.js'
import type { ClientMessage, DeliveredMessage, ServerMessage, SystemEvent } from '../protocol.js'

/**
 * CC-321: one wake per finished agent. Reports to the session that spawned the
 * sender wait out one window and go as a single push, and a spawner that was
 * pushed an agent's closing report is not also pushed its clean `agent_exited`.
 * Each test names the mutation it catches. Every name and id here is synthetic.
 */

const WINDOW_MS = 20_000
/** Past `SystemEventFeed`'s own 250 ms coalesce, so a lifecycle push has gone out if it was going to. */
const LIFECYCLE_MS = 300

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

const tmpDirs: string[] = []
let realHome: string | undefined
let windowMs: number
let core: BrokerCore
let server: SocketServer
let exitChild: (code: number) => void

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** A headless child whose exit the test fires. */
const controlledChild = () => ({
  pid: 4242,
  unref: () => undefined,
  once: (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'exit') exitChild = code => listener(code, null)
  },
})

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  process.env.AGENT_CHAT_HOME = tmp('agent-chat-bus-')
  windowMs = WINDOW_MS
  core = new BrokerCore<Conn>(deliver, {
    events: new EventLog(path.join(process.env.AGENT_CHAT_HOME, 'events.db')),
    registry: new Registry<Conn>(),
    reportBatchMs: () => windowMs,
    isSeat: name => name === 'seat',
  })
  server = new SocketServer(core, { surface: { platform: 'linux', spawn: controlledChild } })
})

afterEach(() => {
  vi.useRealTimers()
  server.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function wire(): Wire {
  const frames: ServerMessage[] = []
  const write = (chunk: string): boolean => {
    for (const line of chunk.split('\n').filter(Boolean)) frames.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, frames }
}

const send = (from: Wire, frame: ClientMessage): void => server.handleMessage(from.conn, frame)

function session(name: string, agentId?: string): Wire {
  const w = wire()
  send(w, {
    t: 'register',
    name,
    workingOn: '',
    cwd: `/tmp/${name}`,
    pid: 1,
    ...(agentId ? { agentId } : {}),
  })
  return w
}

/** A worker `spawner` started: its spawn row is what makes `spawner` its coordinator. */
function worker(name: string, spawner: Wire): Wire {
  const spawnerName = core.registry.nameOf(spawner.conn) as string
  const { msgId } = core.append({ kind: 'agent_spawned', actor: spawnerName, target: name, body: 'work' })
  core.registry.recordSpawn(spawner.conn, name)
  core.registry.subscribe(spawner.conn, [
    { selector: { spawnedBy: 'self' }, kinds: ['agent_attached', 'agent_exited'] },
  ])
  return session(name, msgId)
}

const say = (from: Wire, to: string, text: string): void => send(from, { t: 'send', to, text })

const pushes = (w: Wire): DeliveredMessage[] => w.frames.flatMap(f => (f.t === 'deliver' ? [f.message] : []))

const lifecycle = (w: Wire): SystemEvent[] => w.frames.flatMap(f => (f.t === 'system_events' ? f.events : []))

const exitsPushedTo = (w: Wire): string[] =>
  lifecycle(w)
    .filter(e => e.kind === 'agent_exited')
    .map(e => e.subject)

const idOf = (w: Wire): string => core.registry.entryFor(w.conn)?.agentId as string

/** A clean exit by default; the feed's own coalesce window is waited out before returning. */
function exit(w: Wire, name: string, meta: Record<string, string> = { code: '0' }): void {
  core.append({ kind: 'agent_exited', actor: name, ref: idOf(w), body: '', meta })
  vi.advanceTimersByTime(LIFECYCLE_MS)
}

/** A reconnected session re-declares its subscriptions; this is the one these tests need. */
function watchExitOf(w: Wire, name: string): void {
  core.registry.subscribe(w.conn, [{ selector: { name }, kinds: ['agent_exited'] }])
}

const message = (msgId: string, from = 'w-a'): DeliveredMessage => ({
  msgId,
  from,
  text: 'Status: DONE',
  at: 0,
})

describe('reports to one coordinator inside the window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  // Mutation caught: `flush` pushing each held message on its own instead of `batchOf`.
  it('delivers a burst of three as one push that holds each report whole', () => {
    const coord = session('coord')
    const [a, b, c] = ['w-a', 'w-b', 'w-c'].map(name => worker(name, coord)) as [Wire, Wire, Wire]

    say(a, 'coord', 'Status: DONE\nPR: example/repo#1')
    vi.advanceTimersByTime(5_000)
    say(b, 'coord', 'Verdict: MERGE\nno findings')
    say(c, 'coord', 'Status: BLOCKED\nneeds a decision')
    vi.advanceTimersByTime(WINDOW_MS - 5_001)
    expect(pushes(coord)).toEqual([])
    vi.advanceTimersByTime(1)

    const [batch, ...rest] = pushes(coord)
    expect(rest).toEqual([])
    const inbox = core.events.inboxFor('coord', 10)
    expect(batch?.batch).toEqual(inbox.map(m => ({ msgId: m.msgId, from: m.from })))
    expect(batch?.batch?.map(m => m.from)).toEqual(['w-a', 'w-b', 'w-c'])
    const parts = inbox.map((m, i) => `[${i + 1}/3] from ${m.from}, msg_id ${m.msgId}\n${m.text}`)
    expect(batch?.text.endsWith(parts.join('\n\n'))).toBe(true)
    expect(batch?.from).toBe('agent-chat')
  })

  // Mutation caught: a lone held report wrapped as a batch of one.
  it('delivers a lone report unchanged once its window ends', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)

    say(a, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(WINDOW_MS)

    const [only] = pushes(coord)
    expect(pushes(coord)).toHaveLength(1)
    expect(only).toMatchObject({ from: 'w-a', text: 'Status: DONE' })
    expect(only?.batch).toBeUndefined()
  })

  // Mutation caught: the window restarting on each report (sliding rather than fixed).
  it('never holds the first report longer than one window', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]

    say(a, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(WINDOW_MS - 1)
    say(b, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(1)

    expect(pushes(coord)[0]?.batch).toHaveLength(2)
  })

  // Mutation caught: `held` shared across connections instead of keyed by recipient.
  it('gives each of two coordinators a batch of its own reports only', () => {
    const [north, south] = [session('north'), session('south')]
    const [a, b] = [worker('w-a', north), worker('w-b', north)]
    const [c, d] = [worker('w-c', south), worker('w-d', south)]

    say(a, 'north', 'Status: DONE')
    say(c, 'south', 'Status: DONE')
    say(b, 'north', 'Status: DONE')
    say(d, 'south', 'Verdict: MERGE')
    vi.advanceTimersByTime(WINDOW_MS)

    expect(pushes(north)).toHaveLength(1)
    expect(pushes(south)).toHaveLength(1)
    expect(pushes(north)[0]?.batch?.map(m => m.from)).toEqual(['w-a', 'w-b'])
    expect(pushes(south)[0]?.batch?.map(m => m.from)).toEqual(['w-c', 'w-d'])
  })

  // Mutation caught: `report` ignoring a zero window and arming a timer anyway.
  it('pushes each report at once, as before, when the window is 0', () => {
    windowMs = 0
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]

    say(a, 'coord', 'Status: DONE')
    say(b, 'coord', 'Status: DONE')

    expect(pushes(coord).map(m => [m.from, m.text, m.batch])).toEqual([
      ['w-a', 'Status: DONE', undefined],
      ['w-b', 'Status: DONE', undefined],
    ])
  })

  // Mutation caught: `handleHumanSend` or `core.answer` routed through `report` instead of `now`.
  it('delivers a human message and a chat_ask answer at once, behind the held report', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    const human = wire()
    send(coord, { t: 'ask', text: 'merge it?' })
    const question = core.events.humanQueue()[0]?.msgId as string

    say(a, 'coord', 'Status: DONE')
    send(human, { t: 'human_send', to: 'coord', text: 'stop after this one' })
    expect(pushes(coord).map(m => m.from)).toEqual(['w-a', 'human'])
    say(a, 'coord', 'Status: DONE again')
    send(human, { t: 'answer', msgId: question, text: 'yes' })

    expect(pushes(coord).map(m => [m.from, m.text])).toEqual([
      ['w-a', 'Status: DONE'],
      ['human', 'stop after this one'],
      ['w-a', 'Status: DONE again'],
      ['human', 'yes'],
    ])
  })

  // Mutation caught: `endorse` delivering through the batch window.
  it('delivers a human-endorsed message at once even when it opens like a report', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    send(a, { t: 'endorse', to: 'coord', text: 'Status: the owner says ship it' })
    const request = core.events.humanQueue()[0]?.msgId as string

    send(wire(), { t: 'endorse_approve', msgId: request })

    expect(pushes(coord)).toHaveLength(1)
    expect(pushes(coord)[0]).toMatchObject({ from: 'w-a', provenance: 'human-endorsed' })
  })

  // Mutation caught: `now` pushing without first flushing what is held for that connection.
  it('sends a progress message at once and the held report ahead of it', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]

    say(a, 'coord', 'Status: DONE')
    say(b, 'coord', 'halfway through, tests next')

    expect(pushes(coord).map(m => m.text)).toEqual(['Status: DONE', 'halfway through, tests next'])
    vi.advanceTimersByTime(WINDOW_MS)
    expect(pushes(coord)).toHaveLength(2)
  })

  // Mutation caught: `isReportToSpawner` holding any report-shaped message, whoever it is for.
  it('holds nothing between workers, or from a coordinator to its worker', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]

    say(a, 'w-b', 'Status: DONE, your turn')
    say(coord, 'w-a', 'Status: please rebase')

    expect(pushes(b).map(m => m.text)).toEqual(['Status: DONE, your turn'])
    expect(pushes(a).map(m => m.text)).toEqual(['Status: please rebase'])
  })

  // Mutation caught: `drop` not forgetting the batch, so the timer writes to a closed connection.
  it('pushes nothing to a coordinator that deregistered, and keeps its reports in its inbox', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]
    say(a, 'coord', 'Status: DONE')
    say(b, 'coord', 'Status: DONE')

    core.drop(coord.conn)
    vi.advanceTimersByTime(WINDOW_MS)

    expect(pushes(coord)).toEqual([])
    expect(core.events.inboxFor('coord', 10).map(m => m.from)).toEqual(['w-a', 'w-b'])
  })

  // Mutation caught: `drop` discarding a seat's held reports, which the CC-320 hold does not cover.
  it('pushes a seat the reports its connection closed on when it registers again', () => {
    const seat = session('seat')
    const a = worker('w-a', seat)
    say(a, 'seat', 'Status: DONE')
    core.drop(seat.conn)
    vi.advanceTimersByTime(WINDOW_MS)
    say(a, 'seat', 'Status: DONE, and one thing more')

    const back = session('seat')

    expect(pushes(seat)).toEqual([])
    expect(pushes(back).map(m => m.text)).toEqual(['Status: DONE', 'Status: DONE, and one thing more'])
  })

  // Mutation caught: `close` not flushing, so a clean shutdown leaves the batch unpushed.
  it('pushes a held batch when the broker shuts down cleanly', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]
    say(a, 'coord', 'Status: DONE')
    say(b, 'coord', 'Status: DONE')
    const events = vi.spyOn(core.events, 'close').mockImplementation(() => undefined)

    core.close()

    expect(pushes(coord)[0]?.batch).toHaveLength(2)
    events.mockRestore()
  })

  // Mutation caught: `headerOf` dropping the thread a report answers.
  it('keeps the in_reply_to of a report inside a batch', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]
    say(coord, 'w-a', 'take the flaky test')
    const assignment = core.events.inboxFor('w-a', 1)[0]?.msgId as string

    send(a, { t: 'send', to: 'coord', text: 'Status: DONE', inReplyTo: assignment })
    say(b, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(WINDOW_MS)

    expect(pushes(coord)[0]?.text).toContain(`, in_reply_to ${assignment}\nStatus: DONE`)
  })

  // Mutation caught: `batchMeta` leaving the senders or ids out of the attributes.
  it('names every real sender and id in the attributes the recipient sees', () => {
    const batch = [
      { msgId: 'id-one', from: 'w-a' },
      { msgId: 'id-two', from: 'w-b' },
    ]

    expect(batchMeta(batch)).toEqual({ count: '2', senders: 'w-a,w-b', msg_ids: 'id-one,id-two' })
  })

  // Mutation caught: the broadcast exemption removed, so a worker's broadcast is held for its spawner alone.
  it('delivers a broadcast at once to the spawner, even when it opens like a report', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)

    send(a, { t: 'broadcast', text: 'Status: DONE, main is green again' })

    expect(pushes(coord).map(m => [m.text, m.broadcast])).toEqual([
      ['Status: DONE, main is green again', true],
    ])
  })

  // Mutation caught: a failed write left to throw, which costs the next coordinator its batch.
  it('still pushes the second coordinator its batch at shutdown when the first one cannot be written', () => {
    const [north, south] = [session('north'), session('south')]
    say(worker('w-a', north), 'north', 'Status: DONE')
    say(worker('w-b', south), 'south', 'Status: DONE')
    north.conn.write = () => {
      throw new Error('write after end')
    }
    const events = vi.spyOn(core.events, 'close').mockImplementation(() => undefined)

    core.close()

    expect(pushes(south).map(m => m.from)).toEqual(['w-b'])
    events.mockRestore()
  })

  // Mutation caught: the oldest remembered id kept and the newest evicted once the memory is full.
  it('forgets the oldest pushed report first once it remembers the maximum', () => {
    const batcher = new ReportBatcher<string>(
      () => undefined,
      () => 0,
    )

    for (let i = 0; i <= MAX_REMEMBERED; i++) batcher.report('coord', message(`id-${i}`))

    expect(batcher.wasPushed('id-0')).toBe(false)
    expect(batcher.wasPushed('id-1')).toBe(true)
    expect(batcher.wasPushed(`id-${MAX_REMEMBERED}`)).toBe(true)
  })
})

describe('a report that is held and not yet written', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  /** A coordinator that is itself an agent, so a second connection with its agent id takes it over. */
  const coordinator = (name: string): Wire => worker(name, session('root'))

  // Mutation caught: a report counted as pushed when it is held.
  it('does not count as pushed until its frame is written', () => {
    const batcher = new ReportBatcher<string>(
      () => undefined,
      () => WINDOW_MS,
    )

    batcher.report('coord', message('id-one'))
    expect(batcher.wasPushed('id-one')).toBe(false)
    batcher.flush('coord')

    expect(batcher.wasPushed('id-one')).toBe(true)
  })

  // Mutation caught: the exit judged without first flushing, so the notice is muted for a report nobody was pushed.
  it.each(['coord', 'seat'])(
    'is pushed to %s at the exit, which is then not announced, and is not pushed again after a reconnect',
    name => {
      const coord = session(name)
      const a = worker('w-a', coord)
      say(a, name, 'Status: DONE')
      expect(pushes(coord)).toEqual([])

      exit(a, 'w-a')
      core.drop(coord.conn)
      const back = session(name)
      vi.advanceTimersByTime(WINDOW_MS)

      expect(pushes(coord).map(m => m.text)).toEqual(['Status: DONE'])
      expect(exitsPushedTo(coord)).toEqual([])
      expect(pushes(back)).toEqual([])
    },
  )

  // Mutation caught: a takeover leaving the displaced connection's timer armed, so it is written to after the fact.
  it.each(['coord', 'seat'])(
    'is pushed to %s at the exit, and is not pushed again after a takeover by the same agent',
    name => {
      const coord = coordinator(name)
      const a = worker('w-a', coord)
      say(a, name, 'Status: DONE')

      exit(a, 'w-a')
      const back = session(name, idOf(coord))
      vi.advanceTimersByTime(WINDOW_MS)

      expect(pushes(coord).map(m => m.text)).toEqual(['Status: DONE'])
      expect(exitsPushedTo(coord)).toEqual([])
      expect(pushes(back)).toEqual([])
    },
  )

  // Mutation caught: only a seat's held reports kept for its next connection.
  it.each(['coord', 'seat'])(
    'goes to the connection %s reconnects on when the first one closed inside the window',
    name => {
      const coord = session(name)
      const a = worker('w-a', coord)
      say(a, name, 'Status: DONE')

      core.drop(coord.conn)
      const back = session(name)
      watchExitOf(back, 'w-a')
      exit(a, 'w-a')
      vi.advanceTimersByTime(WINDOW_MS)

      expect(pushes(coord)).toEqual([])
      expect(pushes(back).map(m => m.text)).toEqual(['Status: DONE'])
      expect(exitsPushedTo(back)).toEqual([])
    },
  )

  // Mutation caught: a takeover not handing the displaced connection's held reports to its successor.
  it.each(['coord', 'seat'])(
    'goes to the connection that takes %s over inside the window, and to no other',
    name => {
      const coord = coordinator(name)
      const a = worker('w-a', coord)
      say(a, name, 'Status: DONE')

      const back = session(name, idOf(coord))
      watchExitOf(back, 'w-a')
      exit(a, 'w-a')
      vi.advanceTimersByTime(WINDOW_MS)

      expect(pushes(coord)).toEqual([])
      expect(pushes(back).map(m => m.text)).toEqual(['Status: DONE'])
      expect(exitsPushedTo(back)).toEqual([])
    },
  )

  // Mutation caught: a report counted as pushed when it is held, or when its write was refused.
  it.each(['destroyed', 'writableEnded'])(
    'leaves the exit notice in place when the connection is %s, and goes to the next connection',
    flag => {
      const coord = session('coord')
      const a = worker('w-a', coord)
      say(a, 'coord', 'Status: DONE')
      Object.assign(coord.conn, { [flag]: true })

      exit(a, 'w-a')
      core.drop(coord.conn)
      const back = session('coord')

      expect(pushes(coord)).toEqual([])
      expect(exitsPushedTo(coord)).toEqual(['w-a'])
      expect(pushes(back).map(m => m.text)).toEqual(['Status: DONE'])
    },
  )

  // Mutation caught: stranded reports kept after they are pushed, so every later reconnect repeats them.
  it('is pushed once to a coordinator that reconnects twice', () => {
    const coord = session('coord')
    say(worker('w-a', coord), 'coord', 'Status: DONE')
    core.drop(coord.conn)
    const second = session('coord')
    core.drop(second.conn)

    const third = session('coord')

    expect(pushes(second).map(m => m.text)).toEqual(['Status: DONE'])
    expect(pushes(third)).toEqual([])
  })

  it('reaches a coordinator that reconnects as one batch when several were held', () => {
    const coord = session('coord')
    say(worker('w-a', coord), 'coord', 'Status: DONE')
    say(worker('w-b', coord), 'coord', 'Verdict: MERGE')
    core.drop(coord.conn)

    const back = session('coord')

    expect(pushes(back)).toHaveLength(1)
    expect(pushes(back)[0]?.batch?.map(m => m.from)).toEqual(['w-a', 'w-b'])
  })

  // Mutation caught: the exit judged before the flush, so the notice overtakes the report it follows.
  it('is pushed ahead of the exit notice when the spawner wrote to the agent after it', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(10)
    windowMs = 0
    send(coord, { t: 'send', to: 'w-a', text: 'also fix the flake before you stop' })

    exit(a, 'w-a')

    const order = coord.frames.flatMap(f => (f.t === 'deliver' || f.t === 'system_events' ? [f.t] : []))
    expect(order.slice(-2)).toEqual(['deliver', 'system_events'])
    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: any exit ending the window, which would undo batching for every other worker.
  it('stays held through the exit of a different agent', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]
    say(a, 'coord', 'Status: DONE')

    exit(b, 'w-b')

    expect(pushes(coord)).toEqual([])
  })
})

describe('the agent_exited notice to a spawner that was pushed the final report', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    windowMs = 0
  })

  const watcher = (): Wire => {
    const w = session('watcher')
    core.registry.subscribe(w.conn, [{ selector: { all: true }, kinds: ['agent_exited'] }])
    return w
  }

  // Mutation caught: `reportedSpawner` muting every subscriber rather than the spawner alone.
  it('is skipped for a Status, while another subscriber and the log still get the exit', () => {
    const coord = session('coord')
    const other = watcher()
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual([])
    expect(exitsPushedTo(other)).toEqual(['w-a'])
    expect(core.events.agentEvents().filter(r => r.kind === 'agent_exited')).toHaveLength(1)
  })

  // Mutation caught: the report test narrowed to `Status:` only.
  it('is skipped for a reviewer Verdict', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Verdict: MERGE')

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual([])
  })

  // Mutation caught: a closing status left out of the terminal set.
  it.each(['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT', '**done**'])(
    'is skipped for a terminal Status of %s followed by a prompt clean exit',
    status => {
      const coord = session('coord')
      const a = worker('w-a', coord)
      say(a, 'coord', `Status: ${status}\nPR: example/repo#1`)

      exit(a, 'w-a')

      expect(exitsPushedTo(coord)).toEqual([])
    },
  )

  // Mutation caught: suppression on any `Status:` line, terminal or not.
  it('is pushed when a progress Status is followed by the exit', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: IN PROGRESS\nhalfway through, tests next')

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: the exit code ignored, so a crash after a report goes unannounced.
  it('is pushed when a terminal Status is followed by exit code 1', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')

    exit(a, 'w-a', { code: '1' })

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: an exit with no code read as clean.
  it('is pushed when a terminal Status is followed by a signalled exit', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')

    exit(a, 'w-a', { signal: 'SIGKILL' })

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: the closing-act gap removed or widened.
  it('is pushed when a terminal Status is followed by a long silence and then the exit', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(CLOSING_ACT_MS + 1)

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: the closing-act gap narrowed, or its boundary made exclusive.
  it('is skipped when the exit comes exactly at the end of the closing-act gap', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(CLOSING_ACT_MS)

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual([])
  })

  // Mutation caught: a follow-up looked for since the run began, so an assignment sent before the report counts.
  it('is skipped when the spawner last wrote to the agent before its report', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(coord, 'w-a', 'take the flaky test')
    vi.advanceTimersByTime(10)
    say(a, 'coord', 'Status: DONE')

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual([])
  })

  // Mutation caught: a closed connection's pushes still counting for the one that replaced it.
  it.each(['reconnect', 'takeover'])(
    'is pushed to a spawner whose %s left it on a connection the report was never written to',
    how => {
      const coord = worker('coord', session('root'))
      const a = worker('w-a', coord)
      say(a, 'coord', 'Status: DONE')
      const agentId = idOf(coord)
      if (how === 'reconnect') core.drop(coord.conn)

      const back = session('coord', agentId)
      watchExitOf(back, 'w-a')
      exit(a, 'w-a')

      expect(pushes(back)).toEqual([])
      expect(exitsPushedTo(back)).toEqual(['w-a'])
    },
  )

  // Mutation caught: `reportedSpawner` returning the spawner whatever the last message was.
  it('is pushed when the agent sent no message at all', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: any earlier report counting, instead of the newest message.
  it('is pushed when a later message follows the Status, so the Status was not final', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')
    say(a, 'coord', 'one more thing, CI went red')

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: the follow-up check removed, so a worker given more work exits unannounced.
  it('is pushed when the spawner wrote to the agent after its report', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')
    say(coord, 'w-a', 'also fix the flake before you stop')

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: `wasPushed` dropped, so a report that was only logged mutes the exit.
  it('is pushed when the report was held by do-not-disturb and never pushed', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    send(coord, { t: 'status', status: 'working', dnd: true })
    say(a, 'coord', 'Status: DONE')
    send(coord, { t: 'status', status: 'working', dnd: false })

    exit(a, 'w-a')

    expect(pushes(coord)).toEqual([])
    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: run start ignored, so a report from before a resume mutes the resumed run's exit.
  it('is pushed when the only report came before the agent was resumed', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(10)
    core.append({ kind: 'agent_resumed', actor: 'coord', ref: idOf(a) })

    exit(a, 'w-a')

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: the mute applied to every kind, not `agent_exited` alone.
  it('leaves agent_attached and agent_retired to a subscribed spawner alone', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    core.registry.subscribe(coord.conn, [{ selector: { name: 'w-a' }, kinds: ['agent_retired'] }])
    say(a, 'coord', 'Status: DONE')

    core.append({ kind: 'agent_retired', actor: 'coord', target: 'w-a', ref: idOf(a) })
    vi.advanceTimersByTime(LIFECYCLE_MS)

    expect(lifecycle(coord).map(e => e.kind)).toEqual(['agent_attached', 'agent_retired'])
  })
})

describe('a headless agent exiting under the supervisor', () => {
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

  /** `coord` spawns `scout` over the socket; the scout then registers as a real agent does. */
  async function spawnScout(coord: Wire): Promise<Wire> {
    send(coord, {
      t: 'spawn',
      name: 'scout',
      profile: 'explorer',
      brief: 'do the task',
      cwd: tmp('agent-chat-ws-'),
      isolation: 'none',
      surface: 'headless',
      spawnerConfigDir: tmp('agent-chat-account-'),
    })
    const agentId = await vi.waitFor(() => {
      const id = core.agents.byName('scout')?.agentId
      if (id === undefined) throw new Error('not spawned yet')
      return id
    })
    const scout = session('scout', agentId)
    await vi.waitFor(() => expect(coord.frames.some(f => f.t === 'spawn_result' && f.ok)).toBe(true))
    return scout
  }

  async function exitAndSettle(code = 0): Promise<void> {
    exitChild(code)
    await vi.waitFor(() => expect(core.events.agentEvents().some(r => r.kind === 'agent_exited')).toBe(true))
    await pause(LIFECYCLE_MS)
  }

  const unreported = (w: Wire): DeliveredMessage[] => pushes(w).filter(m => m.event === 'unreported-exit')

  // Mutation caught: the feed built without `reportedSpawner`, so the spawner is woken twice.
  it('wakes its spawner once, with the Status, and sends no exit notice of either kind', async () => {
    windowMs = 0
    const coord = session('coord')
    const scout = await spawnScout(coord)
    say(scout, 'coord', 'Status: DONE\nPR: example/repo#1')

    await exitAndSettle()

    expect(pushes(coord).map(m => m.text)).toEqual(['Status: DONE\nPR: example/repo#1'])
    expect(exitsPushedTo(coord)).toEqual([])
  })

  // Mutation caught: the feed not handed the exit row's code, so a crashed agent reads as a clean exit.
  it('sends the exit notice when the agent crashes after its Status', async () => {
    windowMs = 0
    const coord = session('coord')
    const scout = await spawnScout(coord)
    say(scout, 'coord', 'Status: DONE\nPR: example/repo#1')

    await exitAndSettle(1)

    expect(exitsPushedTo(coord)).toEqual(['scout'])
  })

  // Mutation caught: a progress message counting as the report, which would silence both notices.
  it('still sends the CC-266 notice and the exit after a progress message with no Status', async () => {
    windowMs = 0
    const coord = session('coord')
    const scout = await spawnScout(coord)
    say(scout, 'coord', 'halfway through, tests next')

    await exitAndSettle()

    expect(unreported(coord).map(m => m.text)).toEqual([
      'scout exited with no Status report; last action: unknown',
    ])
    expect(exitsPushedTo(coord)).toEqual(['scout'])
  })
})
