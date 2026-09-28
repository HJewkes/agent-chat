import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { observedModel, projectSlug } from '../agents/transcript.js'

/** A fake `~/.claude` with synthetic rows only, as in transcript.test.ts. */
let configDir: string

const CWD = '/work/example-project'
const SESSION = '00000000-0000-4000-8000-000000000001'

const write = (rows: unknown[], trailing = ''): void => {
  const dir = path.join(configDir, 'projects', projectSlug(CWD))
  fs.mkdirSync(dir, { recursive: true })
  const body = rows.map(r => JSON.stringify(r)).join('\n')
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), `${body}\n${trailing}`)
}

const user = (text: string, sessionId = SESSION) => ({
  type: 'user',
  sessionId,
  message: { role: 'user', content: text },
})

const assistant = (model: string, sessionId = SESSION) => ({
  type: 'assistant',
  sessionId,
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
})

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-model-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('the model a session was observed running on', () => {
  it('is the newest assistant model', () => {
    write([user('a'), assistant('claude-sonnet-5'), user('b'), assistant('claude-opus-5')])
    expect(observedModel(CWD, SESSION)).toBe('claude-opus-5')
  })

  it('skips a <synthetic> newest row and reports the previous real model', () => {
    write([user('a'), assistant('claude-opus-5'), user('b'), assistant('<synthetic>')])
    expect(observedModel(CWD, SESSION)).toBe('claude-opus-5')
  })

  it('reads a single-row transcript', () => {
    write([assistant('claude-opus-5')])
    expect(observedModel(CWD, SESSION)).toBe('claude-opus-5')
  })

  it('still finds the model past a malformed row and a half-flushed final line', () => {
    write([assistant('claude-opus-5'), 'not json', user('b')], '{"type":"assis')
    expect(observedModel(CWD, SESSION)).toBe('claude-opus-5')
  })

  it('finds the model in a transcript larger than the tail window', () => {
    const padding = Array.from({ length: 400 }, (_, i) => user(`${i} ${'x'.repeat(1000)}`))
    write([assistant('claude-haiku-4-5'), ...padding, assistant('claude-opus-5'), user('tail')])
    expect(observedModel(CWD, SESSION)).toBe('claude-opus-5')
  })

  it('is undefined when the only assistant row falls outside the tail window', () => {
    const padding = Array.from({ length: 400 }, (_, i) => user(`${i} ${'x'.repeat(1000)}`))
    write([assistant('claude-opus-5'), ...padding])
    expect(observedModel(CWD, SESSION)).toBeUndefined()
  })

  it('is undefined for a missing transcript', () => {
    expect(observedModel(CWD, SESSION)).toBeUndefined()
  })

  it('is undefined, not a throw, when the window names another session', () => {
    write([assistant('claude-opus-5', '00000000-0000-4000-8000-00000000000f')])
    expect(observedModel(CWD, SESSION)).toBeUndefined()
  })
})
