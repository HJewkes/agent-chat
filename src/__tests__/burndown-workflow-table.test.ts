import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWorkflowTable, readWorkflowTable } from '../agents/burndown/workflow-table.js'

/** CC-637: the shape-v1 workflow table and its lint. */

const REPO_TABLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'workflow',
  'shape-v1.yml',
)
const repoText = fs.readFileSync(REPO_TABLE, 'utf8')
const repoTable = () => parse(repoText) as Record<string, any>
const lint = (table: unknown) => parseWorkflowTable(stringify(table)).problems

describe('the repo copy of the workflow table', () => {
  it('passes the lint with all eleven classes and eight priors', () => {
    const read = parseWorkflowTable(repoText)

    expect(read.problems).toBeUndefined()
    expect(Object.keys(read.table!.workflow)).toHaveLength(11)
    expect(read.table!.priors.map(rule => rule.prior)).toEqual([
      'one-way',
      'safety-path',
      'ui-round',
      'cross-package',
      'agent-text',
      'small',
      'standard',
      'needs-plan',
    ])
  })
})

describe('the workflow table lint', () => {
  it('refuses an unknown class key in workflow', () => {
    const table = repoTable()
    table.workflow['big-bang'] = table.workflow['local-fix']

    expect(lint(table)).toEqual(['at workflow: unknown class "big-bang"'])
  })

  it('refuses an unknown class a prior is sent to', () => {
    const table = repoTable()
    table.priorWorkflow.small = 'tiny-fix'

    expect(lint(table)).toEqual(['at priorWorkflow.small: unknown class "tiny-fix"'])
  })

  it('refuses an unknown prior in a rule', () => {
    const table = repoTable()
    table.priors[2].prior = 'visual'

    expect(lint(table)).toEqual(['at priors.2.prior: unknown prior "visual"'])
  })

  it('refuses an unknown implementer profile, split or not', () => {
    const table = repoTable()
    table.workflow['agent-text'].implementer = 'bd-implementer-max'
    table.workflow['local-fix'].implementerAbove2 = 'opus'

    expect(lint(table)).toEqual([
      'at workflow.agent-text.implementer: unknown implementer profile "bd-implementer-max"',
      'at workflow.local-fix.implementerAbove2: unknown implementer profile "opus"',
    ])
  })

  it.each([
    ['review', 'owner-only', 'unknown review ladder value "owner-only"'],
    ['merge', 'MRG-AU-XX', 'unknown merge ladder value "MRG-AU-XX"'],
  ])('refuses an unknown %s ladder value', (column, value, message) => {
    const table = repoTable()
    table.workflow.mechanical[column] = value

    expect(lint(table)).toEqual([`at workflow.mechanical.${column}: ${message}`])
  })

  it('refuses a misspelt key', () => {
    const table = repoTable()
    table.workflow.inert.reveiw = 'ci'

    expect(lint(table)).toEqual(['at workflow.inert: Unrecognized key: "reveiw"'])
  })

  it('refuses a priors list with no fallback row last', () => {
    const table = repoTable()
    table.priors.pop()

    expect(lint(table)).toEqual(['priors has no fallback row last'])
  })

  it('refuses a rule naming a path list the file does not define', () => {
    const table = repoTable()
    table.priors[2].owns = 'visuals'

    expect(lint(table)).toEqual(['at priors.2.owns: unknown path list "visuals"'])
  })
})

describe('reading the table from the autonomy root', () => {
  let root: string | undefined

  afterEach(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true })
  })

  it('is undefined with no file, and the linted table with one', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-workflow-'))

    expect(readWorkflowTable(root)).toBeUndefined()

    fs.mkdirSync(path.join(root, 'workflow'))
    fs.copyFileSync(REPO_TABLE, path.join(root, 'workflow', 'shape-v1.yml'))

    expect(readWorkflowTable(root)?.table?.version).toBe('shape-v1')
  })
})
