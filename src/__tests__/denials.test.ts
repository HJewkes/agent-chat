import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findDenials } from '../agents/denials.js'
import { projectSlug } from '../agents/transcript.js'

/** Same discipline as transcript.test.ts: a fake `~/.claude`, never the real one. */
let configDir: string

const CWD = '/Users/hjewkes/projects/agent-chat'
const SESSION = '90b4944a-2f7e-4142-93e8-572847efd6d3'

const writeTranscript = (rows: unknown[]): void => {
  const dir = path.join(configDir, 'projects', projectSlug(CWD))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION}.jsonl`)
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}

/** A `tool_use` row followed by the `tool_result` row it produced, as Claude Code writes them. */
const toolUse = (id: string, name: string) => ({
  message: { content: [{ type: 'tool_use', id, name }] },
})
const toolResult = (id: string, isError: boolean, text: string, toolDenialKind?: string) => ({
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] },
  ...(toolDenialKind ? { toolDenialKind } : {}),
})

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-denials-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('findDenials', () => {
  it('returns nothing for an agent with no transcript yet', () => {
    expect(findDenials(CWD, SESSION, 10)).toEqual([])
  })

  it('finds a settings-level denial, matched back to the tool that was denied', () => {
    writeTranscript([
      toolUse('toolu_1', 'Bash'),
      toolResult('toolu_1', true, 'Permission to use Bash with command echo hello has been denied.'),
    ])

    expect(findDenials(CWD, SESSION, 10)).toEqual([
      { tool: 'Bash', detail: 'Permission to use Bash with command echo hello has been denied.' },
    ])
  })

  it('carries toolDenialKind as a refinement, not the primary signal', () => {
    writeTranscript([toolUse('toolu_1', 'Bash'), toolResult('toolu_1', true, 'denied', 'permission-rule')])

    expect(findDenials(CWD, SESSION, 10)).toEqual([
      { tool: 'Bash', detail: 'denied', kind: 'permission-rule' },
    ])
  })

  it('ignores a tool_result that succeeded', () => {
    writeTranscript([toolUse('toolu_1', 'Bash'), toolResult('toolu_1', false, 'hello')])

    expect(findDenials(CWD, SESSION, 10)).toEqual([])
  })

  /**
   * The whole point of case (A) from CC-29: a toolset-confined tool never appears
   * as a `tool_use` at all, so there is nothing for this scanner to find. This
   * test documents that limit rather than papering over it.
   */
  it('finds nothing for a toolset-confined tool, which never emits a tool_use', () => {
    writeTranscript([{ message: { content: [{ type: 'text', text: 'I do not have a Bash tool.' }] } }])

    expect(findDenials(CWD, SESSION, 10)).toEqual([])
  })

  it('caps output at the given limit, keeping the most recent denials', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [
      toolUse(`toolu_${i}`, 'Bash'),
      toolResult(`toolu_${i}`, true, `denial ${i}`),
    ]).flat()
    writeTranscript(rows)

    const denials = findDenials(CWD, SESSION, 2)
    expect(denials.map(d => d.detail)).toEqual(['denial 3', 'denial 4'])
  })

  it('skips an unparseable trailing line instead of throwing', () => {
    const dir = path.join(configDir, 'projects', projectSlug(CWD))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${SESSION}.jsonl`)
    fs.writeFileSync(file, `${JSON.stringify(toolUse('toolu_1', 'Bash'))}\n{"message":{"conte`)

    expect(findDenials(CWD, SESSION, 10)).toEqual([])
  })
})
