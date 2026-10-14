import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, CLOSING_ACT_MS, type Conn } from '../broker/core.js'
import { deliver, SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-337: an exit is judged when its report is written, not when it lands. A burst of
 * finished agents is one wake, and a visible pane's inferred exit after its report is
 * as quiet as a headless agent's code 0. Each test names the mutation it catches.
 * Every name and id here is synthetic.
 */

const WINDOW_MS = 20_000
/** Past `SystemEventFeed`'s own 250 ms coalesce, so a lifecycle push has gone out if it was going to. */
const LIFECYCLE_MS = 300

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

const tmpDirs: string[] = []
let windowMs: number
let core: BrokerCore
let server: SocketServer

beforeEach(() => {
  vi.useFakeTimers()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bus-'))
  tmpDirs.push(home)
  windowMs = WINDOW_MS
  core = new BrokerCore<Conn>(deliver, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
    reportBatchMs: () => windowMs,
  })
  server = new SocketServer(core, { surface: { platform: 'linux' } })
})

afterEach(() => {
  vi.useRealTimers()
  server.close()
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

/** A worker `spawner` started on `surface`, with the spawner subscribed to its exit. */
function worker(name: string, spawner: Wire, surface = 'headless'): Wire {
  const spawnerName = core.registry.nameOf(spawner.conn) as string
  const { msgId } = core.append({
    kind: 'agent_spawned',
    actor: spawnerName,
    target: name,
    body: 'work',
    meta: { surface },
  })
  core.registry.subscribe(spawner.conn, [{ selector: { name }, kinds: ['agent_exited'] }])
  return session(name, msgId)
}

const say = (from: Wire, to: string, text: string): void => send(from, { t: 'send', to, text })

function exit(w: Wire, name: string, meta: Record<string, string> = { code: '0' }): void {
  const ref = core.registry.entryFor(w.conn)?.agentId as string
  core.append({ kind: 'agent_exited', actor: name, ref, body: '', meta })
  vi.advanceTimersByTime(LIFECYCLE_MS)
}

/** The frames that each cost the coordinator a turn: pushed messages and lifecycle events. */
const wakes = (w: Wire): ServerMessage[] => w.frames.filter(f => f.t === 'deliver' || f.t === 'system_events')

const exitsPushedTo = (w: Wire): string[] =>
  w.frames
    .flatMap(f => (f.t === 'system_events' ? f.events : []))
    .flatMap(e => (e.kind === 'agent_exited' ? [e.subject] : []))

const INFERRED = { inferred: 'true' }

describe('three headless agents finishing 5 s apart inside one window', () => {
  // Mutation caught: an exit ending its spawner's window early, as before CC-337 (3 frames).
  it('wake their coordinator once, with every report and no exit notice', () => {
    const coord = session('coord')
    for (const name of ['w-a', 'w-b', 'w-c']) {
      const agent = worker(name, coord)
      say(agent, 'coord', 'Status: DONE')
      exit(agent, name)
      vi.advanceTimersByTime(5_000 - LIFECYCLE_MS)
    }

    vi.advanceTimersByTime(WINDOW_MS + LIFECYCLE_MS)

    expect(wakes(coord)).toHaveLength(1)
    const [frame] = wakes(coord)
    expect(frame?.t === 'deliver' ? frame.message.batch?.map(m => m.from) : []).toEqual(['w-a', 'w-b', 'w-c'])
    expect(exitsPushedTo(coord)).toEqual([])
  })

  // Mutation caught: a deferred exit never judged, so a worker that crashed later in the window goes unannounced.
  it('announce only the one whose last word was progress, after the batch', () => {
    const coord = session('coord')
    const [a, b] = [worker('w-a', coord), worker('w-b', coord)]
    say(a, 'coord', 'Status: DONE')
    say(b, 'coord', 'Status: DONE')
    say(b, 'coord', 'Status: IN PROGRESS\nCI went red, looking again')

    exit(a, 'w-a')
    exit(b, 'w-b')
    vi.advanceTimersByTime(WINDOW_MS + LIFECYCLE_MS)

    expect(wakes(coord).map(f => f.t)).toEqual(['deliver', 'system_events'])
    expect(exitsPushedTo(coord)).toEqual(['w-b'])
  })
})

describe('an exit while its report is held', () => {
  // Mutation caught: a crash deferred like a clean exit, which would delay the news of it by a window.
  it('ends the window at once when the exit is a crash, report first', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')

    exit(a, 'w-a', { code: '1' })

    expect(wakes(coord).map(f => f.t)).toEqual(['deliver', 'system_events'])
    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: the closing-act gap measured at flush time, so a window longer than the gap announces the exit.
  it('is judged by when it happened, not by when the window ended', () => {
    windowMs = CLOSING_ACT_MS + 60_000
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')

    exit(a, 'w-a')
    vi.advanceTimersByTime(windowMs + LIFECYCLE_MS)

    expect(wakes(coord)).toHaveLength(1)
    expect(exitsPushedTo(coord)).toEqual([])
  })

  // Mutation caught: the exit writing the held report to a coordinator that then closes, so its successor gets nothing.
  it('leaves the report for the connection that takes the name when the coordinator closes inside the window', () => {
    const coord = session('coord')
    const a = worker('w-a', coord)
    say(a, 'coord', 'Status: DONE')
    exit(a, 'w-a')

    core.drop(coord.conn)
    vi.advanceTimersByTime(WINDOW_MS + LIFECYCLE_MS)
    const back = session('coord')

    expect(wakes(coord)).toEqual([])
    expect(wakes(back).flatMap(f => (f.t === 'deliver' ? [f.message.text] : []))).toEqual(['Status: DONE'])
  })
})

describe('an inferred exit after a terminal report', () => {
  beforeEach(() => {
    windowMs = 0
  })

  // Mutation caught: only exit code 0 muting, so a closed pane always costs a second wake.
  it.each(['iterm-pane', 'iterm-tab', 'iterm-window', 'tmux-window'])(
    'is muted for an agent on a %s',
    surface => {
      const coord = session('coord')
      const a = worker('w-a', coord, surface)
      say(a, 'coord', 'Status: DONE')

      exit(a, 'w-a', INFERRED)

      expect(exitsPushedTo(coord)).toEqual([])
    },
  )

  // Mutation caught: the surface check dropped, so a reaped headless process that may have crashed is muted.
  it.each(['headless', ''])('is announced for an agent on surface %j', surface => {
    const coord = session('coord')
    const a = worker('w-a', coord, surface)
    say(a, 'coord', 'Status: DONE')

    exit(a, 'w-a', INFERRED)

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: an inferred exit that also failed, or was signalled, read as a closed pane.
  it.each([{ failed: 'true' }, { signal: 'SIGKILL' }, { code: '1' }])(
    'is announced for a visible agent when the exit also carries %j',
    extra => {
      const coord = session('coord')
      const a = worker('w-a', coord, 'iterm-pane')
      say(a, 'coord', 'Status: DONE')

      exit(a, 'w-a', { ...INFERRED, ...extra })

      expect(exitsPushedTo(coord)).toEqual(['w-a'])
    },
  )

  // Mutation caught: a visible agent's inferred exit muted whatever it said last.
  it('is announced for a visible agent whose last message was progress', () => {
    const coord = session('coord')
    const a = worker('w-a', coord, 'iterm-pane')
    say(a, 'coord', 'halfway through, tests next')

    exit(a, 'w-a', INFERRED)

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })

  // Mutation caught: the inferred mute skipping the closing-act gap.
  it('is announced for a visible agent whose report is older than the closing-act gap', () => {
    const coord = session('coord')
    const a = worker('w-a', coord, 'iterm-pane')
    say(a, 'coord', 'Status: DONE')
    vi.advanceTimersByTime(CLOSING_ACT_MS + 1)

    exit(a, 'w-a', INFERRED)

    expect(exitsPushedTo(coord)).toEqual(['w-a'])
  })
})
