import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliArgs, type VerbContext } from '../cli/command.js'
import { askVerb } from '../cli/verbs/ask.js'
import { reapBroker } from './broker-harness.js'

/**
 * CC-169 slice c: a process that is not a Claude session asks the human with
 * `agent-chat ask`, exits, and a fresh process reads the answer back with
 * `agent-chat answers`. Run against the built `dist/cli.js` and a real broker.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const BROKER_UNAVAILABLE_EXIT = 69

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

let home: string
let fakeBroker: net.Server | undefined

function cli(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, AGENT_CHAT_HOME: home, ...options.env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  child.stdin.end(options.input ?? '')
  return new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })))
}

const ask = (label: string, text: string, extra: string[] = []) =>
  cli(['ask', '--as', label, '--text-stdin', ...extra], { input: text })

/** A broker from before CC-169: it accepts the connection and drops frames it does not know. */
function listenAsOldBroker(): Promise<void> {
  fakeBroker = net.createServer(socket => socket.on('data', () => undefined))
  return new Promise(resolve => fakeBroker!.listen(path.join(home, 'chat.sock'), resolve))
}

beforeEach(() => {
  expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-askcli-'))
})

afterEach(async () => {
  if (fakeBroker) await new Promise(resolve => fakeBroker!.close(resolve))
  fakeBroker = undefined
  await reapBroker(home)
  fs.rmSync(home, { recursive: true, force: true })
})

describe('agent-chat ask and answers against a live broker', () => {
  // Mutation caught: ask printing anything besides the id, which breaks `id=$(agent-chat ask ...)`.
  it('reads back the one answer to an ask from a separate process after the asker exited', async () => {
    const asked = await ask('factory-t', 'Merge gate 7?')
    const id = asked.stdout.trim()

    await cli(['answer', id, 'approve'])
    const json = await cli(['answers', 'factory-t', '--since', id, '--json'])
    const plain = await cli(['answers', 'factory-t'])

    expect(asked.code).toBe(0)
    expect(asked.stdout).toMatch(/^\S+\n$/)
    expect(json.code).toBe(0)
    const body = JSON.parse(json.stdout) as { answers: Array<Record<string, unknown>>; next?: string }
    expect(body.answers).toHaveLength(1)
    expect(body.answers[0]).toMatchObject({ questionId: id, outcome: 'answered', text: 'approve' })
    expect(body.next).toBe(body.answers[0]!.msgId)
    expect(plain.stdout).toBe(`answered ${id} ${String(body.answers[0]!.msgId)}: approve\n`)
  }, 30_000)

  it('prints the id as a JSON object with --json, and a dismissal reads back as dismissed', async () => {
    const asked = await ask('factory-t', 'Deploy?', ['--json'])
    const { msgId } = JSON.parse(asked.stdout) as { msgId: string }

    await cli(['dismiss', msgId])
    const { stdout } = await cli(['answers', 'factory-t', '--json'])

    expect(asked.code).toBe(0)
    expect(Object.keys(JSON.parse(asked.stdout) as object)).toEqual(['msgId'])
    expect((JSON.parse(stdout) as { answers: unknown[] }).answers).toEqual([
      expect.objectContaining({ questionId: msgId, outcome: 'dismissed' }),
    ])
  }, 30_000)

  // Mutation caught: exiting 0 when the reply carries an error.
  it('reads an empty list before any answer, and refuses an unknown --since', async () => {
    const id = (await ask('factory-t', 'Anything?')).stdout.trim()

    const empty = await cli(['answers', 'factory-t', '--since', id, '--json'])
    const bogus = await cli(['answers', 'factory-t', '--since', 'no-such-id', '--json'])

    expect(empty.code).toBe(0)
    expect(JSON.parse(empty.stdout)).toEqual({ answers: [] })
    expect(bogus.code).not.toBe(0)
    expect(bogus.stderr).not.toBe('')
  }, 30_000)

  it('exits 1 on a broker refusal and 2 on a usage error, printing nothing on stdout', async () => {
    const refused = await ask('Not A Label', 'Hello?')
    const noText = await cli(['ask', '--as', 'factory-t'])
    const noLabel = await cli(['ask', '--text-stdin'], { input: 'Hello?' })
    const emptyStdin = await ask('factory-t', '  \n')
    const unknownFlag = await cli(['ask', '--as', 'factory-t', '--bogus'])

    expect(refused.code).toBe(1)
    expect(refused.stderr).not.toBe('')
    for (const run of [noText, noLabel, emptyStdin, unknownFlag]) expect(run.code).toBe(2)
    for (const run of [refused, noText, noLabel, emptyStdin, unknownFlag]) expect(run.stdout).toBe('')
  }, 30_000)
})

describe('agent-chat ask and answers without a usable broker', () => {
  it('exits BROKER_UNAVAILABLE_EXIT when no broker listens and autostart is off', async () => {
    const env = { AGENT_CHAT_NO_AUTOSTART: '1' }

    const asked = await cli(['ask', '--as', 'factory-t', '--text-stdin'], { input: 'Hello?', env })
    const read = await cli(['answers', 'factory-t'], { env })

    expect(asked.code).toBe(BROKER_UNAVAILABLE_EXIT)
    expect(read.code).toBe(BROKER_UNAVAILABLE_EXIT)
  }, 30_000)

  // R8: a broker that predates the frames drops them, so the verb must time out rather than hang.
  it('says the broker is too old when it never answers the frame', async () => {
    await listenAsOldBroker()

    const [asked, read] = await Promise.all([ask('factory-t', 'Hello?'), cli(['answers', 'factory-t'])])

    for (const run of [asked, read]) {
      expect(run.code).toBe(BROKER_UNAVAILABLE_EXIT)
      expect(run.stderr).toContain('broker too old')
      expect(run.stdout).toBe('')
    }
  }, 30_000)
})

describe('agent-chat ask item shape', () => {
  // Mutation caught: a repeated --option collapsing to its last value, or never reaching the frame.
  it('sends every --option, the task and the label in one service_ask frame', async () => {
    const sent: unknown[] = []
    const ctx = {
      warnings: [],
      format: 'human',
      withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
        fn({
          request: async (frame: unknown) => {
            sent.push(frame)
            return { t: 'service_ask_result', ok: true, msgId: 'q1' }
          },
        }),
    } as unknown as VerbContext
    const args = cliArgs(askVerb, [['Merge', 'gate', '7?']], {
      as: 'factory-t',
      option: ['approve', 'decline'],
      task: 'gate-7',
    })

    const report = await askVerb.run(askVerb.args.parse(args), ctx)

    expect(report).toEqual({ ok: true, lines: ['q1'] })
    expect(sent).toEqual([
      expect.objectContaining({
        t: 'service_ask',
        as: 'factory-t',
        text: 'Merge gate 7?',
        task: 'gate-7',
        options: ['approve', 'decline'],
      }),
    ])
  })
})
