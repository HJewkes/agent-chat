import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installCrashLog } from '../broker/crash-log.js'

/** CC-1505: a broker whose stdio is discarded still leaves its crash in broker.log. */

let dir: string
let exits: number[]

const brokerLog = (): Array<Record<string, unknown>> =>
  fs
    .readFileSync(path.join(dir, 'broker.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)

function crashingProcess(): EventEmitter {
  const proc = new EventEmitter()
  installCrashLog(proc, code => exits.push(code))
  return proc
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-crash-'))
  process.env.AGENT_CHAT_HOME = dir
  exits = []
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a broker that throws where nothing catches', () => {
  it('logs broker_crashed with the stack, then exits non-zero', () => {
    const err = new Error('launch exploded')

    crashingProcess().emit('uncaughtException', err)

    expect(brokerLog().at(-1)).toMatchObject({
      event: 'broker_crashed',
      kind: 'uncaughtException',
      error: 'launch exploded',
      stack: err.stack,
    })
    expect(exits).toEqual([1])
  })

  it('logs a rejection nothing handled, including one that is not an Error', () => {
    crashingProcess().emit('unhandledRejection', 'plain reason')

    expect(brokerLog().at(-1)).toMatchObject({
      event: 'broker_crashed',
      kind: 'unhandledRejection',
      error: 'plain reason',
    })
    expect(exits).toEqual([1])
  })
})
