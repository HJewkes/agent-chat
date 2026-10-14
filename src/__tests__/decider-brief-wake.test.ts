import os from 'node:os'
import { describe, expect, it } from 'vitest'
import type { BriefRoute } from '../agents/burndown/brief-approve.js'
import { type DeciderVerdict, waitingQuestions } from '../agents/burndown/decider.js'
import type { SpawnReply } from '../agents/burndown/execute.js'
import { EMPTY_LEDGER, type Ledger } from '../agents/burndown/ledger.js'
import { actOnDeciderAndBriefs, type TickBroker } from '../agents/burndown/run-tick.js'
import { TickConfigSchema } from '../agents/burndown/source.js'
import type { QueueItem } from '../protocol.js'

const SENT = 'brief:decider=abc123'
const ROUTE: BriefRoute = {
  slug: 'demo',
  taskId: 'T-1',
  tag: SENT,
  stale: [],
  section: 'The proposed brief for T-1 failed the checks.',
}
const OTHER: BriefRoute = { ...ROUTE, taskId: 'T-2', tag: 'brief:decider=def456', section: 'T-2 failed too.' }
const config = TickConfigSchema.parse({ enabled: true, decider: { name: 'decider' } })
const MINUTE_MS = 60_000
const now = new Date('2026-10-13T12:00:00Z')
const wake = (waiting: number, briefs = 1): DeciderVerdict => ({
  wake: true,
  message: 'queue only',
  waiting,
  briefs,
})

interface Rig {
  edits: string[][]
  resumed: { message: string; editsAtResume: string[][] }[]
  written: Ledger[]
}

function rig(opts: { write?: (l: Ledger) => void; addFails?: (id: string) => boolean } = {}) {
  const state: Rig = { edits: [], resumed: [], written: [] }
  const broker = {
    resume: async (_name: string, message: string): Promise<SpawnReply> => {
      state.resumed.push({ message, editsAtResume: state.edits.map(e => [...e]) })
      return { ok: true } as SpawnReply
    },
  } as unknown as TickBroker
  const briefEdit = (_slug: string, id: string, args: string[]): void => {
    state.edits.push(args)
    if (opts.addFails?.(id) === true && args[0] === '--add-tag') throw new Error('synthetic add failure')
  }
  const deps = {
    broker,
    log: () => undefined,
    now,
    write: opts.write ?? ((l: Ledger) => void state.written.push(l)),
  }
  return { state, deps, opts: { root: os.tmpdir(), briefEdit } }
}

describe('the decider wake records brief sends after its ledger write (CC-1239)', () => {
  it('records no brief tag when the counting ledger write throws', async () => {
    const throwing = rig({
      write: () => {
        throw new Error('synthetic ledger write failure')
      },
    })

    const acting = actOnDeciderAndBriefs(
      config,
      { decider: wake(0), briefRoutes: [ROUTE] },
      EMPTY_LEDGER,
      throwing.deps,
      throwing.opts,
    )

    await expect(acting).rejects.toThrow('synthetic ledger write failure')
    expect(throwing.state.edits.filter(e => e[0] === '--add-tag')).toEqual([])
    expect(throwing.state.resumed).toEqual([])
  })

  it('records the tag before the frame goes out', async () => {
    const { state, deps, opts } = rig({ addFails: id => id === 'T-2' })

    await actOnDeciderAndBriefs(
      config,
      { decider: wake(0, 2), briefRoutes: [ROUTE, OTHER] },
      EMPTY_LEDGER,
      deps,
      opts,
    )

    expect(state.resumed).toHaveLength(1)
    expect(state.resumed[0]?.editsAtResume).toEqual([
      ['--add-tag', SENT],
      ['--add-tag', OTHER.tag],
      ['--remove-tag', OTHER.tag],
    ])
    expect(state.resumed[0]?.message).toContain(ROUTE.section)
    expect(state.resumed[0]?.message).not.toContain(OTHER.section)
  })

  it('sends nothing when no record lands and no question waits', async () => {
    const { state, deps, opts } = rig({ addFails: () => true })

    const acted = await actOnDeciderAndBriefs(
      config,
      { decider: wake(0), briefRoutes: [ROUTE] },
      EMPTY_LEDGER,
      deps,
      opts,
    )

    expect(state.resumed).toEqual([])
    expect(acted.lines.join('\n')).toContain('not woken: no brief send could be recorded')
    expect(state.written.at(-1)).toEqual(EMPTY_LEDGER)
    expect(acted.ledger).toEqual(EMPTY_LEDGER)
  })

  it('still offers a question too young to wait at an empty wake on the next tick', async () => {
    const { deps, opts } = rig({ addFails: () => true })
    const young = {
      msgId: 'q1',
      kind: 'question',
      from: 'peer',
      text: '?',
      at: now.getTime() - MINUTE_MS,
      meta: {},
    }

    const acted = await actOnDeciderAndBriefs(
      config,
      { decider: wake(0), briefRoutes: [ROUTE] },
      EMPTY_LEDGER,
      deps,
      opts,
    )
    const nextTick = new Date(now.getTime() + 5 * MINUTE_MS)

    expect(waitingQuestions([young as QueueItem], acted.ledger.decider, nextTick)).toHaveLength(1)
  })
})
