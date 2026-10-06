import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_WORKER_REPORT_LENGTH, WorkerFactsSchema } from '@titan-design/agent-protocol/worker-facts'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import type { AppendInput } from '../broker/event-store.js'
import { readExitTail } from '../agents/exit-report.js'
import { readTranscriptSpend } from '../agents/transcript-spend.js'
import { completionPayload, taskIdOf, type CompletionInput } from '../agents/worker-facts.js'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'worker-facts-2026-10-05')
const WORKER = 'tc-xy-1234-sample-fix'
const SPAWNER = 'coordinator'
const EXIT = { code: 0, signal: null, inferred: false }

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function loggedRun(keep: (row: AppendInput) => boolean = () => true): EventLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-worker-facts-'))
  dirs.push(dir)
  const log = new EventLog(path.join(dir, 'events.db'))
  const rows = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'events.json'), 'utf8')) as AppendInput[]
  for (const row of rows.filter(keep)) log.append(row)
  return log
}

/** What the supervisor gathers at exit, from the fixture's log and transcript. */
async function gathered(transcriptName: string, log = loggedRun()): Promise<CompletionInput> {
  const transcript = path.join(FIXTURE, transcriptName)
  const report = log.lastStatusReport(WORKER, [SPAWNER], 0)
  return {
    agentId: 'spawn01',
    agent: WORKER,
    profile: 'implementer',
    spawner: SPAWNER,
    exit: EXIT,
    ...(report === undefined ? {} : { report }),
    spend: await readTranscriptSpend(transcript),
    ...(report === undefined ? { lastAction: readExitTail(transcript).lastAction } : {}),
  }
}

describe('the on_complete payload of a reporting worker', () => {
  it('carries every WorkerFacts field beside the unchanged legacy fields', async () => {
    const input = await gathered('transcript.jsonl')
    const spend = await readTranscriptSpend(path.join(FIXTURE, 'transcript.jsonl'))
    if (!spend.ok) throw new Error(spend.reason)

    const payload = completionPayload(input)

    expect(payload).toMatchObject({ agentId: 'spawn01', code: 0, signal: null, inferred: false })
    expect(payload.lastAction).toBeUndefined()
    const facts = WorkerFactsSchema.parse(payload.facts)
    expect(facts.agent).toBe(WORKER)
    expect(facts.profile).toBe('implementer')
    expect(facts.spawner).toBe(SPAWNER)
    expect(facts.taskId).toBe('XY-1234')
    expect(facts.report?.messageId).toBe('msg-done')
    expect(facts.report?.kind).toBe('status')
    expect(facts.report?.text.startsWith('Status: DONE\nPR: example-org/example-repo#42')).toBe(true)
    expect(facts.report?.text).toHaveLength(MAX_WORKER_REPORT_LENGTH)
    expect(facts.pr).toEqual({ repo: 'example-org/example-repo', number: 42 })
    expect(facts.tokens).toEqual({ input: 13_070, output: 1_000, total: 14_070 })
    expect(facts.costUsd).toBe(spend.usd_est)
    expect(facts.costUsd).toBeGreaterThan(0)
    expect(facts.exit).toEqual(EXIT)
  })

  it('still reads as the legacy shape to a consumer that knows only agentId and the exit', async () => {
    const payload = JSON.parse(JSON.stringify(completionPayload(await gathered('transcript.jsonl'))))

    const { agentId, code, signal, inferred } = payload as Record<string, unknown>

    expect({ agentId, code, signal, inferred }).toEqual({ agentId: 'spawn01', ...EXIT })
  })

  it('takes a Verdict as a report of kind verdict', async () => {
    const log = loggedRun()
    log.append({
      kind: 'message',
      actor: WORKER,
      target: SPAWNER,
      msgId: 'msg-v',
      body: '**Verdict:** approve',
    })

    const facts = completionPayload(await gathered('transcript.jsonl', log)).facts

    expect(facts?.report).toEqual({ messageId: 'msg-v', kind: 'verdict', text: '**Verdict:** approve' })
    expect(facts?.pr).toBeNull()
  })
})

describe('the on_complete payload of a worker that sent no report', () => {
  it('carries exit-report.ts last action beside facts that hold no report', async () => {
    const log = loggedRun(row => row.kind !== 'message')

    const payload = completionPayload(await gathered('transcript-no-report.jsonl', log))

    expect(payload.lastAction).toBe('Bash(git push)')
    expect(payload.facts?.report).toBeNull()
    expect(payload.facts?.pr).toBeNull()
  })

  it('is valid with only agent, profile, spawner and exit', () => {
    const payload = completionPayload({
      agentId: 'a1',
      agent: 'scout',
      profile: 'implementer',
      spawner: 'human',
      exit: { code: null, signal: 'SIGTERM', inferred: true },
      lastAction: 'unknown',
    })

    expect(payload.facts).toEqual({
      agent: 'scout',
      profile: 'implementer',
      spawner: 'human',
      taskId: null,
      report: null,
      pr: null,
      tokens: null,
      costUsd: null,
      exit: { code: null, signal: 'SIGTERM', inferred: true },
    })
    expect(payload.lastAction).toBe('unknown')
  })
})

describe('a facts block that fails the schema', () => {
  it('is dropped and the legacy fields are sent alone', () => {
    const payload = completionPayload({
      agentId: 'a1',
      agent: 'scout',
      profile: '',
      spawner: 'human',
      exit: EXIT,
    })

    expect(payload).toEqual({ agentId: 'a1', ...EXIT })
  })
})

describe('the task id in an agent name', () => {
  it.each([
    ['tc-tp-1735-heap-cap', 'TP-1735'],
    ['tc-cc-763-worker-facts', 'CC-763'],
    ['tc-cc-625-a', 'CC-625'],
    ['scout', null],
    ['tc-review-fix', null],
  ])('%s gives %s', (name, id) => {
    expect(taskIdOf(name)).toBe(id)
  })
})
