import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exitTailOf, readExitTail, unreportedExitText } from '../agents/exit-report.js'

/** Synthetic transcript records in Claude Code's JSONL shape; no real session is read. */
const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  })

const toolResult = (id: string, content: string): string =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  })

const userText = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

const lines = (...records: string[]): string => `${records.join('\n')}\n`

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the last action of an exited agent', () => {
  it('names a background Bash call and calls it pending when nothing reported it finished', () => {
    const tail = exitTailOf(
      lines(
        toolUse('t1', 'Bash', { command: 'gh run watch 123 --exit-status', run_in_background: true }),
        toolResult('t1', 'Command running in background with ID: bg42. Output is being written to a file.'),
      ),
    )

    expect(tail).toEqual({ lastAction: 'Bash(run_in_background)', pendingBackground: true })
  })

  it('does not call a background task pending once a notification says it completed', () => {
    const tail = exitTailOf(
      lines(
        toolUse('t1', 'Bash', { command: 'npm run verify', run_in_background: true }),
        toolResult('t1', 'Command running in background with ID: bg42.'),
        userText('<task-notification><task-id>bg42</task-id><status>completed</status></task-notification>'),
        toolUse('t2', 'Bash', { command: 'git status' }),
        toolResult('t2', 'clean'),
      ),
    )

    expect(tail).toEqual({ lastAction: 'Bash(git status)', pendingBackground: false })
  })

  it('treats a final ScheduleWakeup as pending background work', () => {
    const tail = exitTailOf(lines(toolUse('t1', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'check CI' })))

    expect(tail).toEqual({ lastAction: 'ScheduleWakeup', pendingBackground: true })
  })

  it('keeps only the plain leading words of a command, dropping paths and values', () => {
    const tail = exitTailOf(
      lines(
        toolUse('t1', 'Bash', {
          command:
            'cd /private/project/dir && gh pr create --title "secret title" --body-file /private/body.md',
        }),
      ),
    )

    expect(tail.lastAction).toBe('Bash(gh pr create)')
  })

  it('reduces a binary given by path to its name', () => {
    const tail = exitTailOf(lines(toolUse('t1', 'Bash', { command: '/opt/tools/bin/sleep 300' })))

    expect(tail.lastAction).toBe('Bash(sleep)')
  })

  it('names an MCP tool by its short name', () => {
    const tail = exitTailOf(lines(toolUse('t1', 'mcp__plugin_agent-chat_agent-chat__chat_send', { to: 'x' })))

    expect(tail.lastAction).toBe('chat_send')
  })

  it('ignores a subagent sidechain, whose tool calls are not the agent’s own', () => {
    const sidechain = JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: {} }] },
    })

    const tail = exitTailOf(lines(toolUse('t1', 'Read', { file_path: '/x' }), sidechain))

    expect(tail.lastAction).toBe('Read')
  })

  it('says so when the tail holds no tool call at all', () => {
    expect(exitTailOf(lines(userText('hello'), 'not json'))).toEqual({
      lastAction: 'no tool call',
      pendingBackground: false,
    })
  })
})

describe('reading the transcript file', () => {
  const file = (text: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-exit-'))
    tmpDirs.push(dir)
    const target = path.join(dir, 'session.jsonl')
    fs.writeFileSync(target, text)
    return target
  }

  it('reads unknown, never throws, for a missing transcript', () => {
    expect(readExitTail(path.join(os.tmpdir(), 'agent-chat-no-such', 'x.jsonl'))).toEqual({
      lastAction: 'unknown',
      pendingBackground: false,
    })
    expect(readExitTail(undefined).lastAction).toBe('unknown')
  })

  it('reads only the tail, skipping the record the cut lands in', () => {
    const early = toolUse('t1', 'Bash', { command: 'npm test' })
    const late = toolUse('t2', 'ScheduleWakeup', { delaySeconds: 60 })
    const target = file(lines(early, 'x'.repeat(4096), late))

    expect(readExitTail(target, late.length + 10).lastAction).toBe('ScheduleWakeup')
    expect(readExitTail(target).lastAction).toBe('ScheduleWakeup')
  })
})

describe('the notice to the spawner', () => {
  it('names the agent and its last action', () => {
    expect(unreportedExitText('scout', { lastAction: 'Bash(gh pr create)', pendingBackground: false })).toBe(
      'scout exited with no Status report; last action: Bash(gh pr create)',
    )
  })

  it('uses the CC-255 wording when background work was pending, and stays under 300 characters', () => {
    const text = unreportedExitText('a'.repeat(200), {
      lastAction: 'Bash(run_in_background)',
      pendingBackground: true,
    })

    expect(text).toContain('exited with a pending background task, no final report')
    expect(text.length).toBeLessThanOrEqual(300)
  })
})
