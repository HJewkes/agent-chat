import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Ledger } from '../agents/burndown/ledger.js'
import { scoredSeatPlan } from '../cli/verbs/burndown.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { readInitiatives } from '../agents/burndown/source.js'
import { renderPlan } from '../agents/burndown/tick.js'

/** CC-1220: a row blocked by a dependency sentence is refused by name instead of dropped. */

const AUTONOMY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const NOW = new Date(2026, 8, 29, 10)
const RUN_START = NOW.getTime() - 3_600_000
const LEDGER: Ledger = {
  ...EMPTY_LEDGER,
  seats: {
    'seat-a': {
      configDir: '/tmp/pool-x',
      samples: [
        { at: new Date(2026, 8, 29, 6).getTime(), sevenDay: 38 },
        { at: RUN_START, sevenDay: 39 },
      ],
    },
  },
}

describe('a task blocked by a dependency sentence', () => {
  const saved = { ...process.env }
  let root: string

  const addTask = (id: string, notes: string) => {
    fs.mkdirSync(path.join(root, 'init-alpha', 'tasks'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'init-alpha', 'tasks', `${id}.yml`),
      `id: ${id}\ntitle: task ${id}\npriority: 1\nseverity: high\nestimate: 2\n` +
        `done_when: The widget renders.\nstatus: open\ntags: []\nnotes: ${JSON.stringify(notes)}\n` +
        'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
    )
  }

  const tick = () => {
    const deps: SeatTickDeps = {
      autonomyRoot: root,
      root,
      now: NOW,
      reading: () => ({ reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 } }),
      meters: () => ({ run: { since: RUN_START, last: 40, spent: 0 } }),
    }
    const { loaded } = loadSeats(['seat-a'], LEDGER, deps)
    return planSeats(
      loaded,
      { ledger: LEDGER, initiatives: readInitiatives(root), scopeTagAliases: {} },
      root,
    )
  }

  const refusedLines = () =>
    renderPlan({ ...tick(), notOptedIn: [], skippedTasks: [] }, NOW).filter(line =>
      line.startsWith('refused '),
    )

  const scoredLines = () => {
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = root
    const config = { briefGate: {}, briefMaxAgeDays: 7, scopeTagAliases: {} }
    return scoredSeatPlan('seat-a', { autonomyRoot: root, today: '2026-09-29' }, config)
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-prose-dep-'))
    fs.cpSync(AUTONOMY, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'init-alpha'))
    fs.writeFileSync(path.join(root, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
    addTask('AA-1', '')
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('prints a dep-blocked refusal quoting the sentence and the open id in plan --seat', () => {
    addTask('AA-2', 'Context first. depends on AA-1')

    expect(refusedLines()).toEqual(['refused init-alpha AA-2 [dep-blocked]: depends on AA-1 names open AA-1'])
    expect(tick().dispatch.map(d => d.task)).toEqual(['AA-1'])
  })

  it('records the first open dependency as the refusal blocker', () => {
    addTask('AA-2', 'depends on AA-1')

    expect(tick().refusals[0]!.blocker).toEqual({ task: 'AA-1', state: 'open, no claim' })
  })

  it('names every open id once, on one line, across sentences that wrap', () => {
    addTask('AA-3', '')
    addTask('AA-2', 'depends on AA-1\nand AA-3; blocked by AA-1 and AA-404.')

    expect(refusedLines()).toEqual([
      'refused init-alpha AA-2 [dep-blocked]: depends on AA-1 and AA-3; names open AA-1, AA-3',
    ])
  })

  it('stays silent when the sentence names no open task', () => {
    addTask('AA-2', 'depends on AA-404.')

    expect(refusedLines()).toEqual([])
    expect(tick().dispatch.map(d => d.task)).toEqual(['AA-1', 'AA-2'])
  })

  it('lists the row with its blockers in plan --seat --scored', () => {
    addTask('AA-2', 'depends on AA-1')

    expect(scoredLines().filter(line => line.includes('AA-2'))).toEqual([
      'refused init-alpha AA-2 [dep-blocked]: depends on AA-1 names open AA-1',
    ])
  })
})
