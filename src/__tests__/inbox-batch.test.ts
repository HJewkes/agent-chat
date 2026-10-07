import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, ENDORSE_MAX_AGE_MS, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { Terminal, VerbContext } from '../cli/command.js'
import { approveVerb } from '../cli/verbs/approve.js'
import { dismissVerb } from '../cli/verbs/dismiss.js'
import { endorseVerb } from '../cli/verbs/endorse.js'
import { inboxVerb } from '../cli/verbs/inbox.js'
import { CONTROL_MARK } from '../endorse-command.js'
import { answerBatch, printBatch } from '../inbox/run.js'
import { readSnapshot } from '../inbox/snapshot.js'
import type { ClientMessage, DecisionCitation, ServerMessage } from '../protocol.js'

/**
 * Autonomy slice 5: `inbox --batch`. Each test names the mutation it catches,
 * because the value of batching is only safe if it adds no new way to answer.
 */

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-batch-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

const CITATION: DecisionCitation = {
  precedent: 'transcript session abc tool_use toolu_1: "Keep going" (2026-09-20)',
  class: 'session_control',
  basis: 'precedent',
  reversible: 'the asker stops at its next boundary',
}

function makeEnv(db: string) {
  const core = new BrokerCore(
    (conn, message) =>
      (conn as unknown as Wire['conn'] & { write: (s: string) => void }).write(
        JSON.stringify({ t: 'deliver', message }) + '\n',
      ),
    { events: new EventLog(path.join(home, db)), registry: new Registry<Conn>() },
  )
  const server = new SocketServer(core)
  const wire = (): Wire => {
    const frames: ServerMessage[] = []
    const conn = {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    return { conn, frames }
  }
  const send = (w: Wire, frame: ClientMessage): ServerMessage | undefined => {
    server.handleMessage(w.conn, frame)
    return w.frames.at(-1)
  }
  /** The human: an unregistered connection per call, exactly as `withBroker` opens one. */
  const ctx: VerbContext = {
    warnings: [],
    format: 'human',
    withBroker: async fn => {
      const human = wire()
      const broker = {
        request: async (frame: ClientMessage, expected: string) => {
          server.handleMessage(human.conn, frame)
          return human.frames.find(f => f.t === expected)
        },
      }
      return fn(broker as unknown as BrokerClient)
    },
  }
  return { core, server, wire, send, ctx }
}

type Env = ReturnType<typeof makeEnv>

function register(env: Env, name: string, sessionId?: string): Wire {
  const w = env.wire()
  env.send(w, {
    t: 'register',
    name,
    workingOn: 'w',
    cwd: '/tmp',
    pid: 1,
    ...(sessionId ? { sessionId } : {}),
  })
  return w
}

const msgIdOf = (frame: ServerMessage | undefined): string =>
  (frame as Extract<ServerMessage, { t: 'send_result' }>).msgId!

/** One item of every kind the batch answers, raised the way agents raise them. */
function seed(env: Env) {
  const asker = register(env, 'asker')
  register(env, 'bob', 'session-bob')
  const decider = register(env, 'decider', 'session-decider')
  const deciderId = env.core.registry.entryFor(decider.conn)!.agentId!
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ decider: { agentId: deciderId } }))

  env.send(asker, {
    t: 'approval',
    requestId: 'r1',
    toolName: 'Bash',
    description: 'Run',
    inputPreview: 'ls',
  })
  const approval = env.core.events.humanQueue().find(i => i.kind === 'approval_request')!.msgId
  const question = msgIdOf(
    env.send(asker, { t: 'ask', text: 'Which store for the cache?', recommended: 'sqlite' }),
  )
  const endorse = msgIdOf(env.send(asker, { t: 'endorse', to: 'bob', text: 'please rebase' }))
  const decided = msgIdOf(env.send(asker, { t: 'ask', text: 'Should I continue with the next ready task?' }))
  env.send(decider, { t: 'decided', msgId: decided, text: 'yes, continue', ...CITATION })
  const notice = msgIdOf(env.send(asker, { t: 'notify', text: 'finished the sweep', kind: 'stalled' }))
  return { asker, ids: { approval, question, endorse, decided, notice }, after: env.core.events.latestId() }
}

/** Rows and deliveries with every per-run id replaced by the role it plays. */
function normalised(env: Env, seeded: ReturnType<typeof seed>) {
  const positions = env.core.events
    .since(0, 1000)
    .map((row, i): [string, string] => [row.msgId ?? '', `#${i}`])
  const label = new Map([
    ...positions,
    ...Object.entries(seeded.ids).map(([role, id]): [string, string] => [id, role]),
  ])
  const relabel = (value: string | null | undefined) =>
    value ? [...label].reduce((text, [id, role]) => (id ? text.replaceAll(id, role) : text), value) : value
  const rows = env.core.events.since(seeded.after, 100).map(row => ({
    kind: row.kind,
    actor: row.actor,
    target: row.target,
    ref: relabel(row.ref),
    body: relabel(row.body),
    meta: Object.fromEntries(Object.entries(row.meta).map(([k, v]) => [k, relabel(v)])),
  }))
  const delivered = seeded.asker.frames
    .filter(f => f.t !== 'send_result')
    .map(f =>
      f.t === 'deliver'
        ? {
            ...f.message,
            msgId: '',
            at: 0,
            text: relabel(f.message.text),
            inReplyTo: relabel(f.message.inReplyTo),
          }
        : f,
    )
  return { rows, delivered }
}

const TYPES_Y: Terminal = { isTTY: true, ask: async () => 'y' }

const numberOf = (msgId: string): number => readSnapshot()!.items.find(i => i.msgId === msgId)!.n

describe('a batch answer is a single answer', () => {
  // Mutation caught: any batch verb building its own frame, e.g. overrule sent as `decided`,
  // `accept` sent as an answer, or `allow` routed through dismiss.
  it('leaves the same event-log rows and deliveries as the single-item verbs', async () => {
    const single = makeEnv('single.db')
    const one = seed(single)
    const human = single.wire()
    await approveVerb.run({ id: one.ids.approval, 'allow|deny': 'allow' }, single.ctx)
    single.send(human, { t: 'answer', msgId: one.ids.question, text: 'sqlite', channel: 'inbox-file' })
    await endorseVerb.run({ id: one.ids.endorse, text: 'please rebase', to: 'bob' }, single.ctx)
    single.send(human, { t: 'answer', msgId: one.ids.decided, text: 'stop here', channel: 'inbox-file' })
    await dismissVerb.run({ id: one.ids.notice }, single.ctx)

    const batch = makeEnv('batch.db')
    const two = seed(batch)
    await printBatch(batch.ctx)
    const report = await answerBatch(
      [
        `${numberOf(two.ids.approval)}: allow`,
        `${numberOf(two.ids.question)}: sqlite`,
        `${numberOf(two.ids.endorse)}: endorse`,
        `${numberOf(two.ids.decided)}: overrule stop here`,
        `${numberOf(two.ids.notice)}: dismiss`,
      ].join('\n'),
      { ...batch.ctx, terminal: TYPES_Y },
    )

    expect(report.ok).toBe(true)
    expect(normalised(batch, two)).toEqual(normalised(single, one))
    expect(normalised(batch, two).rows.map(r => r.kind)).toContain('answer')
  })

  // Mutation caught: batch endorse skipping the bare form's terminal rule (CC-419).
  it('sends nothing at all when an endorsement is answered with no terminal', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)

    const report = await answerBatch(
      [`${numberOf(seeded.ids.question)}: sqlite`, `${numberOf(seeded.ids.endorse)}: endorse`].join('\n'),
      env.ctx,
    )

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual(['Nothing sent.'])
    expect(report.errors!.join('\n')).toContain(
      `agent-chat endorse ${seeded.ids.endorse} --to bob --text 'please rebase'`,
    )
    expect(env.core.events.isOpen(seeded.ids.endorse)).toBe(true)
    expect(env.core.events.isOpen(seeded.ids.question)).toBe(true)
  })

  // Mutation caught: the batch approval restating anything but the stored row, e.g. an empty recipient.
  it('restates the stored text and recipient in the frame it sends, after a typed y', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)
    const sent: ClientMessage[] = []
    let shown = ''
    const ctx: VerbContext = {
      ...env.ctx,
      withBroker: fn =>
        env.ctx.withBroker(broker =>
          fn({
            request: (...args: Parameters<BrokerClient['request']>) => (
              sent.push(args[0]),
              broker.request(...args)
            ),
          } as unknown as BrokerClient),
        ),
      terminal: { isTTY: true, ask: async prompt => ((shown = prompt), 'y') },
    }

    const report = await answerBatch(`${numberOf(seeded.ids.endorse)}: endorse`, ctx)

    expect(report.ok).toBe(true)
    expect(shown).toContain('delivered to bob')
    expect(sent.filter(f => f.t === 'endorse_approve')).toEqual([
      { t: 'endorse_approve', msgId: seeded.ids.endorse, text: 'please rebase', to: 'bob' },
    ])
  })

  // Mutation caught: a declined prompt still sending the approval.
  it('leaves an endorsement open when the terminal answer is not y', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)

    const report = await answerBatch(`${numberOf(seeded.ids.endorse)}: endorse`, {
      ...env.ctx,
      terminal: { isTTY: true, ask: async () => 'n' },
    })

    expect(report.ok).toBe(false)
    expect(env.core.events.isOpen(seeded.ids.endorse)).toBe(true)
  })

  // Mutation caught: `accept` on a decided item sent as an answer, which would overrule it.
  it('accepts a decided item through the same dismiss a single accept sends', async () => {
    const single = makeEnv('single.db')
    const one = seed(single)
    await dismissVerb.run({ id: one.ids.decided }, single.ctx)

    const batch = makeEnv('batch.db')
    const two = seed(batch)
    await printBatch(batch.ctx)
    await answerBatch(`${numberOf(two.ids.decided)}: accept`, batch.ctx)

    expect(normalised(batch, two)).toEqual(normalised(single, one))
    expect(normalised(batch, two).rows.map(r => r.body)).toEqual(['dismissed'])
  })

  // Mutation caught: skipping the broker's human-only check by answering on a registered connection.
  it('is refused from a registered session exactly as a single answer is', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)
    const agent = register(env, 'mallory')
    const registeredCtx: VerbContext = {
      ...env.ctx,
      withBroker: async fn =>
        fn({
          request: async (frame: ClientMessage, expected: string) => {
            env.server.handleMessage(agent.conn, frame)
            return agent.frames.find(f => f.t === expected)
          },
        } as unknown as BrokerClient),
    }

    const report = await answerBatch(`${numberOf(seeded.ids.question)}: sqlite`, registeredCtx)

    expect(report.ok).toBe(false)
    expect(env.core.events.isOpen(seeded.ids.question)).toBe(true)
  })
})

describe('a malformed line answers nothing', () => {
  const cases: [
    string,
    (n: (id: string) => number, ids: ReturnType<typeof seed>['ids']) => string,
    RegExp,
  ][] = [
    [
      'a line that is not N: answer',
      (n, ids) => `${n(ids.question)}: sqlite\nsqlite please`,
      /line 2: not an/,
    ],
    ['a number that was never printed', (n, ids) => `${n(ids.question)}: sqlite\n99: yes`, /no item 99/],
    [
      'a verb the item does not take',
      (n, ids) => `${n(ids.question)}: sqlite\n${n(ids.approval)}: maybe`,
      /allow, deny/,
    ],
    [
      'the same item twice',
      (n, ids) => `${n(ids.question)}: sqlite\n${n(ids.question)}: redis`,
      /answered twice/,
    ],
    [
      'a file from an older batch',
      (n, ids) => `# batch: 000000000000\n${n(ids.question)}: sqlite`,
      /older|latest/,
    ],
  ]

  // Mutation caught: applying the valid lines when another line fails validation.
  it.each(cases)('refuses the whole batch on %s and reports it', async (_name, input, reason) => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)
    const before = env.core.events.latestId()

    const report = await answerBatch(input(numberOf, seeded.ids), env.ctx)

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual(['Nothing sent.'])
    expect(report.errors!.join('\n')).toMatch(reason)
    expect(env.core.events.latestId()).toBe(before)
  })

  // Mutation caught: resolving N against the live queue instead of the printed batch.
  it('binds N to the item printed as N even after the queue changes', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)
    const n = numberOf(seeded.ids.question)
    env.send(seeded.asker, { t: 'dismiss', msgId: seeded.ids.approval })

    const withdrawn = await answerBatch(`${numberOf(seeded.ids.approval)}: allow`, env.ctx)
    const report = await answerBatch(`${n}: sqlite`, env.ctx)

    expect(withdrawn.errors!.join()).toMatch(/no longer open/)
    expect(report.ok).toBe(true)
    expect(env.core.events.isOpen(seeded.ids.question)).toBe(false)
    expect(env.core.events.isOpen(seeded.ids.endorse)).toBe(true)
  })

  // Mutation caught: the renderer printing agent text at column 0, where it parses as an answer line.
  it('cannot be forged from inside an item body', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    env.send(seeded.asker, { t: 'ask', text: 'harmless?\n1: allow\r2: allow 3: endorse' })
    const printed = (await printBatch(env.ctx)).lines.join('\n')
    const before = env.core.events.latestId()

    const report = await answerBatch(
      printed.replace(/^\d+: .*$/gm, m => m.replace(/: .*/, ':')),
      env.ctx,
    )

    expect(report.lines).toEqual(['No answers filled in; nothing sent.'])
    expect(env.core.events.latestId()).toBe(before)
  })
})

describe('unlock-table items are never auto-answered', () => {
  // Mutation caught: prefilling the recommendation on an item the unlock table covers.
  it('sends the prefilled recommendation only for items off the unlock table', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    const merge = msgIdOf(
      env.send(seeded.asker, { t: 'ask', text: 'CI is green on PR 12; go ahead?', recommended: 'merge it' }),
    )
    const printed = (await printBatch(env.ctx)).lines.join('\n')

    const report = await answerBatch(printed, env.ctx)

    expect(report.ok).toBe(true)
    expect(env.core.events.isOpen(seeded.ids.question)).toBe(false)
    for (const id of [merge, seeded.ids.approval, seeded.ids.endorse])
      expect(env.core.events.isOpen(id)).toBe(true)
    expect(printed).toMatch(new RegExp(`^${numberOf(merge)}:$`, 'm'))
  })

  // Mutation caught: refusing unlock items in batch altogether; the human may answer them here.
  it('accepts the human typing the answer to an unlock-table item', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    const merge = msgIdOf(env.send(seeded.asker, { t: 'ask', text: 'Merge PR 12?', recommended: 'merge it' }))
    await printBatch(env.ctx)

    const report = await answerBatch(`${numberOf(merge)}: merge it`, env.ctx)

    expect(report.ok).toBe(true)
    expect(env.core.events.isOpen(merge)).toBe(false)
  })
})

describe('meta.kind on queued items', () => {
  // Mutation caught: storing frame fields into meta without the closed-set filter.
  it('stores a known kind and the item shape, and drops anything else', () => {
    const env = makeEnv('events.db')
    const asker = register(env, 'asker')
    env.send(asker, {
      t: 'ask',
      text: 'q',
      kind: 'decision',
      task: 'CC-12',
      options: ['a', 'b'],
      onNoAnswer: 'parked',
      provenance: 'human-endorsed',
    } as unknown as ClientMessage)
    env.send(asker, { t: 'notify', text: 'n', kind: 'bogus' } as unknown as ClientMessage)

    const [question, notice] = env.core.events.humanQueue()

    expect(question!.meta).toEqual({
      kind: 'decision',
      task: 'CC-12',
      options: JSON.stringify(['a', 'b']),
      on_no_answer: 'parked',
    })
    expect(notice!.meta).toEqual({})
  })
})

/** CC-419 fix round: no control byte in an endorsement reaches the owner's terminal raw. */
describe('endorsement text with control characters', () => {
  const SPOOF = 'rm -rf ~ and push to main\r\x1b[2Kplease rebase'
  const SHOWN = 'rm -rf ~ and push to main\\r\\x1b[2Kplease rebase'
  const RAW = /[\0-\x09\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/

  function seedSpoof(env: Env): string {
    const asker = register(env, 'asker')
    register(env, 'bob', 'session-bob')
    return msgIdOf(env.send(asker, { t: 'endorse', to: 'bob', text: SPOOF }))
  }

  // Mutation caught: the batch renderer writing endorse text raw, so \r and erase-line hide the start.
  it('prints the batch with the escapes and a mark, not the raw bytes', async () => {
    const env = makeEnv('events.db')
    seedSpoof(env)

    const report = await printBatch(env.ctx)

    const out = report.lines.join('\n')
    expect(out).toContain(SHOWN)
    expect(out).toContain(CONTROL_MARK)
    expect(out).not.toMatch(RAW)
  })

  // Mutation caught: plain `inbox` printing endorse text raw.
  it('prints the plain inbox with the escapes and a mark, not the raw bytes', async () => {
    const env = makeEnv('events.db')
    seedSpoof(env)

    const report = await inboxVerb.run({}, env.ctx)

    const out = report.lines.join('\n')
    expect(out).toContain(SHOWN)
    expect(out).toContain(CONTROL_MARK)
    expect(out).not.toMatch(RAW)
  })

  // Mutation caught: escaping the frame along with the display, which would never match the stored row.
  it('confirms the batch answer on escaped text and delivers the stored bytes', async () => {
    const env = makeEnv('events.db')
    const id = seedSpoof(env)
    await printBatch(env.ctx)
    let shown = ''

    const report = await answerBatch(`${numberOf(id)}: endorse`, {
      ...env.ctx,
      terminal: { isTTY: true, ask: async prompt => ((shown = prompt), 'y') },
    })

    expect(report.ok).toBe(true)
    expect(shown).toContain(SHOWN)
    expect(shown).not.toMatch(RAW)
    expect(env.core.events.isOpen(id)).toBe(false)
  })
})

describe('inbox --batch --answers source', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Answers arrive on fd 0 as a pipe would deliver them; every other read is real. */
  function stdinAnswers(answers: string) {
    const real = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) =>
      file === 0 ? answers : real(file, options as BufferEncoding)) as typeof fs.readFileSync)
  }

  // Mutation caught: answerCtx keeping the terminal when stdin carried the answers.
  it('treats answers read from stdin as no terminal, even when one is attached', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)
    stdinAnswers(`${numberOf(seeded.ids.endorse)}: endorse`)

    const report = await inboxVerb.run({ batch: true, answers: '-' }, { ...env.ctx, terminal: TYPES_Y })

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual(['Nothing sent.'])
    expect(env.core.events.isOpen(seeded.ids.endorse)).toBe(true)
  })

  it('keeps the terminal when the answers come from a file', async () => {
    const env = makeEnv('events.db')
    const seeded = seed(env)
    await printBatch(env.ctx)
    const file = path.join(home, 'answers.txt')
    fs.writeFileSync(file, `${numberOf(seeded.ids.endorse)}: endorse`)

    const report = await inboxVerb.run({ batch: true, answers: file }, { ...env.ctx, terminal: TYPES_Y })

    expect(report.ok).toBe(true)
    expect(env.core.events.isOpen(seeded.ids.endorse)).toBe(false)
  })
})

/** CC-420 meets CC-419: the CLI's restating form reaches the broker's recipient and age checks. */
describe('endorse --to --text after the request went stale', () => {
  afterEach(() => vi.useRealTimers())

  function request(env: Env) {
    const asker = register(env, 'asker')
    const bob = register(env, 'bob', 'session-bob')
    const id = msgIdOf(env.send(asker, { t: 'endorse', to: 'bob', text: 'please rebase' }))
    return { bob, id }
  }

  // Mutation caught: the CLI approval skipping CC-420's recipient-agent check.
  it('is refused when the recipient name is now held by a different agent', async () => {
    const env = makeEnv('events.db')
    const { bob, id } = request(env)
    env.core.drop(bob.conn)
    register(env, 'bob', 'session-impostor')

    const report = await endorseVerb.run({ id, to: 'bob', text: 'please rebase' }, env.ctx)

    expect(report.ok).toBe(false)
    expect(report.errors!.join()).toMatch(/held by a different agent/)
    expect(env.core.events.isOpen(id)).toBe(true)
  })

  // Mutation caught: the CLI approval skipping CC-420's max-age check.
  it('is refused when the request is older than the max age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T09:00:00Z'))
    const env = makeEnv('events.db')
    const { id } = request(env)
    vi.setSystemTime(Date.now() + ENDORSE_MAX_AGE_MS + 1)

    const report = await endorseVerb.run({ id, to: 'bob', text: 'please rebase' }, env.ctx)

    expect(report.ok).toBe(false)
    expect(report.errors!.join()).toMatch(/older than 24h/)
    expect(env.core.events.isOpen(id)).toBe(true)
  })
})
