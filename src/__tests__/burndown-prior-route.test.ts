import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskFacts } from '../agents/burndown/classify-task.js'
import { planFacts, priorRoute, readPriorRouter, type PriorRouter } from '../agents/burndown/prior-route.js'
import { loadTickConfig } from '../agents/burndown/source.js'
import { parseWorkflowTable, workflowTablePath } from '../agents/burndown/workflow-table.js'

/** CC-638 slice a: the priorRouting key and the pure prior-route decision, over the repo's shape-v1 table. */

const TABLE_TEXT = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'workflow', 'shape-v1.yml'),
  'utf8',
)
const table = parseWorkflowTable(TABLE_TEXT).table!
const on: PriorRouter = { mode: 'on', table }
const LABEL = 'claude-channels CC-1 (seat titan-coord)'

const facts = (over: Partial<TaskFacts>): TaskFacts => ({
  estimate: 2,
  done_when: 'ships',
  tags: [],
  owns: [],
  ...over,
})

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-route-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writeTable(root: string, text: string) {
  const file = workflowTablePath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('the priorRouting tick key', () => {
  it('defaults to off when the config file does not name it', () => {
    const file = path.join(tempDir(), 'burndown.config.json')
    fs.writeFileSync(file, '{}')

    expect(loadTickConfig(file).priorRouting).toBe('off')
  })

  it('refuses a value outside off, shadow and on as a malformed config', () => {
    const file = path.join(tempDir(), 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ priorRouting: 'always' }))

    expect(() => loadTickConfig(file)).toThrow(/malformed/)
  })
})

describe('priorRoute', () => {
  it('routes a kind:security estimate-1 task up to bd-implementer with a route-change note', () => {
    const routed = priorRoute(
      on,
      facts({ estimate: 1, tags: ['kind:security'] }),
      'bd-implementer-lite',
      LABEL,
    )

    expect(routed.profile).toBe('bd-implementer')
    expect(routed.note).toMatch(
      /^route-change claude-channels CC-1 \(seat titan-coord\): bd-implementer-lite -> bd-implementer/,
    )
    expect(routed.note).toContain('prior safety-path')
  })

  it('routes a kind:feature estimate-2 task with a done_when down to bd-implementer-lite (prior standard)', () => {
    const routed = priorRoute(on, facts({ estimate: 2, tags: ['kind:feature'] }), 'bd-implementer', LABEL)

    expect(routed.profile).toBe('bd-implementer-lite')
    expect(routed.note).toContain('prior standard')
  })

  it('in shadow mode keeps today and notes what on would route', () => {
    const routed = priorRoute({ mode: 'shadow', table }, facts({ estimate: 2 }), 'bd-implementer', LABEL)

    expect(routed.profile).toBe('bd-implementer')
    expect(routed.note).toMatch(/^would-route .*: bd-implementer -> bd-implementer-lite/)
  })

  it('adds no note when the prior gives the profile today already gives', () => {
    expect(priorRoute(on, facts({ estimate: 2 }), 'bd-implementer-lite', LABEL)).toEqual({
      profile: 'bd-implementer-lite',
    })
  })

  it('keeps today when the prior names a profile the tick cannot dispatch as an implementer', () => {
    const codeTable = parseWorkflowTable(
      TABLE_TEXT.replace('standard: local-fix', 'standard: generated'),
    ).table!

    expect(
      priorRoute({ mode: 'on', table: codeTable }, facts({ estimate: 2 }), 'bd-implementer', LABEL),
    ).toEqual({
      profile: 'bd-implementer',
    })
  })
})

const PLAN = [
  '# plan',
  '```burndown-slices',
  JSON.stringify([
    {
      n: 'a',
      title: 'one',
      doneWhen: 'x ships',
      points: 1,
      dependsOn: [],
      owns: ['src/agents/x.ts', 'src/agents/y.ts'],
    },
    {
      n: 'b',
      title: 'two',
      doneWhen: 'y ships',
      points: 2,
      dependsOn: ['a'],
      owns: ['src/agents/y.ts', 'src/cli/z.ts'],
    },
  ]),
  '```',
  '',
].join('\n')

describe('planFacts', () => {
  it('gives the union of every slice owns for a task row', () => {
    expect(planFacts(PLAN)).toEqual({ owns: ['src/agents/x.ts', 'src/agents/y.ts', 'src/cli/z.ts'] })
  })

  it('gives the named slice its own owns and points', () => {
    expect(planFacts(PLAN, 'b')).toEqual({ owns: ['src/agents/y.ts', 'src/cli/z.ts'], points: 2 })
  })

  it('gives no owns without a plan or with one that fails the slice lint', () => {
    expect(planFacts(undefined)).toEqual({ owns: [] })
    expect(planFacts('# no block', 'a')).toEqual({ owns: [] })
  })
})

describe('readPriorRouter', () => {
  it('reads nothing when off, so an invalid table yields no note', () => {
    const root = tempDir()
    writeTable(root, 'version: nope\n')

    expect(readPriorRouter('off', root)).toEqual({})
  })

  it('notes the missing table in shadow mode', () => {
    const root = tempDir()

    expect(readPriorRouter('shadow', root)).toEqual({
      note: `prior routing shadow: no workflow table at ${workflowTablePath(root)}; routing as today`,
    })
  })

  it('notes the lint lines of a failing table', () => {
    const root = tempDir()
    writeTable(root, TABLE_TEXT.replace('standard: local-fix', 'standard: nowhere'))

    const { router, note } = readPriorRouter('shadow', root)

    expect(router).toBeUndefined()
    expect(note).toMatch(
      /^prior routing shadow: workflow table: .*unknown class "nowhere".*; routing as today$/,
    )
  })

  it('gives a router over a valid table', () => {
    const root = tempDir()
    writeTable(root, TABLE_TEXT)

    expect(readPriorRouter('on', root).router?.mode).toBe('on')
  })
})
