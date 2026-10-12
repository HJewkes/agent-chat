import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fromDeposit, type OwnerItem, type OwnerItemDeposit } from '@titan-design/owner-queue'
import type { Task } from '../agents/burndown/eligibility.js'
import {
  doneIdsOnDisk,
  fileHumanSteps,
  routeHumanSteps,
  type HumanStepSource,
} from '../agents/burndown/human-steps.js'
import type { OwnerQueuePort } from '../agents/burndown/seat-tick.js'

/**
 * CC-974 slice c: a kind:owner or kind:operator task whose deps are all done is filed once into the owner queue,
 * keyed human-step:<id>; one with an open dep is not, and a failing port is an event, not a failed tick.
 */

const NOW = new Date(2026, 1, 3, 12, 0)

function fakePort() {
  const items: OwnerItem[] = []
  const port: OwnerQueuePort = {
    open: async () => items.filter(i => i.status === 'open'),
    deposit: async (d: OwnerItemDeposit) => {
      items.push(fromDeposit(d, NOW))
      return true
    },
  }
  return { port, items }
}

const step = (over: Partial<Task> = {}): Task => ({
  id: 'DEMO-2',
  title: 'Rebuild the demo CLI',
  status: 'open',
  doneWhen: 'the demo CLI lists --flag',
  tags: ['kind:operator', 'dep:DEMO-1'],
  ...over,
})

const source = (...tasks: Task[]): HumanStepSource[] => [{ seat: 'alpha', tasks: new Map([['demo', tasks]]) }]
const noLog = (): void => {}
const doneIs =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

describe('routeHumanSteps', () => {
  it('files a step whose deps are done once, keyed human-step:<id>', async () => {
    const { port, items } = fakePort()

    const routed = await routeHumanSteps(source(step()), doneIs('DEMO-1'), port, noLog)

    expect(routed).toEqual(['DEMO-2'])
    expect(items).toHaveLength(1)
    expect(items[0]?.keys).toEqual(['human-step:DEMO-2'])
    expect(items[0]?.summary).toBe('[operator] DEMO-2: Rebuild the demo CLI')
    expect(items[0]?.seat).toBe('alpha')
  })

  it('files nothing on the next tick while the item is open, even after the task is retitled', async () => {
    const { port, items } = fakePort()
    await routeHumanSteps(source(step()), doneIs('DEMO-1'), port, noLog)

    const routed = await routeHumanSteps(
      source(step({ title: 'Rebuild the demo CLI at the window' })),
      doneIs('DEMO-1'),
      port,
      noLog,
    )

    expect(routed).toEqual([])
    expect(items).toHaveLength(1)
  })

  it('files nothing while a dep is open', async () => {
    const { port, items } = fakePort()
    const twoDeps = step({ tags: ['kind:owner', 'dep:DEMO-1', 'dep:DEMO-3'] })

    const routed = await routeHumanSteps(source(twoDeps), doneIs('DEMO-1'), port, noLog)

    expect(routed).toEqual([])
    expect(items).toHaveLength(0)
  })

  it('files an owner step with no prefix, and never a task that is not a human step', async () => {
    const { port, items } = fakePort()
    const owner = step({ id: 'DEMO-4', tags: ['kind:owner', 'dep:DEMO-1'] })
    const code = step({ id: 'DEMO-5', tags: ['dep:DEMO-1'] })

    await routeHumanSteps(source(owner, code), doneIs('DEMO-1'), port, noLog)

    expect(items.map(i => i.summary)).toEqual(['DEMO-4: Rebuild the demo CLI'])
  })

  it('counts nothing routed when the spool already holds the answered item', async () => {
    const port: OwnerQueuePort = { open: async () => [], deposit: async () => false }

    const routed = await routeHumanSteps(source(step()), doneIs('DEMO-1'), port, noLog)

    expect(routed).toEqual([])
  })

  it('files the other steps and logs the task when one deposit is refused', async () => {
    const { port, items } = fakePort()
    const refusing: OwnerQueuePort = {
      open: port.open,
      deposit: async d => {
        if (d.keys?.includes('human-step:DEMO-2')) throw new Error('summary too long')
        return port.deposit(d)
      },
    }
    const events: Record<string, unknown>[] = []
    const other = step({ id: 'DEMO-6' })

    const routed = await routeHumanSteps(source(step(), other), doneIs('DEMO-1'), refusing, (_e, d) =>
      events.push(d),
    )

    expect(routed).toEqual(['DEMO-6'])
    expect(items).toHaveLength(1)
    expect(events).toEqual([{ task: 'DEMO-2', detail: 'summary too long' }])
  })

  it('files a step in scope of two seats once', async () => {
    const { port, items } = fakePort()
    const both = [...source(step()), { seat: 'beta', tasks: new Map([['demo', [step()]]]) }]

    await routeHumanSteps(both, doneIs('DEMO-1'), port, noLog)

    expect(items).toHaveLength(1)
  })
})

describe('fileHumanSteps', () => {
  it('logs one event and returns no lines when the port throws', async () => {
    const events: { event: string; detail: Record<string, unknown> }[] = []
    const port: OwnerQueuePort = {
      open: async () => [],
      deposit: async () => {
        throw new Error('spool is read-only')
      },
    }

    const lines = await fileHumanSteps(
      () => source(step()),
      doneIs('DEMO-1'),
      port,
      (event, detail) => events.push({ event, detail }),
    )

    expect(lines).toEqual([])
    expect(events).toEqual([
      { event: 'burndown_human_steps_failed', detail: { task: 'DEMO-2', detail: 'spool is read-only' } },
    ])
  })

  it('returns a line per routed step', async () => {
    const lines = await fileHumanSteps(
      () => source(step()),
      doneIs('DEMO-1'),
      fakePort().port,
      () => {},
    )

    expect(lines).toEqual(['routed human step DEMO-2 to the owner queue'])
  })
})

describe('doneIdsOnDisk', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('counts done and archived tasks as done, and open ones as not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-steps-'))
    dirs.push(root)
    const tasks = path.join(root, 'demo', 'tasks')
    fs.mkdirSync(path.join(tasks, 'archive'), { recursive: true })
    fs.writeFileSync(path.join(tasks, 'DEMO-1.yml'), 'id: DEMO-1\ntitle: one\nstatus: done\n')
    fs.writeFileSync(path.join(tasks, 'DEMO-3.yml'), 'id: DEMO-3\ntitle: three\nstatus: open\n')
    fs.writeFileSync(path.join(tasks, 'archive', 'DEMO-0.yml'), 'id: DEMO-0\ntitle: zero\nstatus: done\n')
    fs.writeFileSync(path.join(tasks, 'archive', 'old-name.yml'), 'id: DEMO-7\ntitle: seven\nstatus: done\n')

    const done = doneIdsOnDisk(root)

    expect([...done].sort()).toEqual(['DEMO-0', 'DEMO-1', 'DEMO-7'])
  })
})
