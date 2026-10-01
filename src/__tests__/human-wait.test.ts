import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { awaitedChildren, classifyWait, parseDirtyPaths, readWait, recordsOf } from '../server/human-wait.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AgentIdentity, QueueItem } from '../protocol.js'

const REPO = '/repo'
const FILE = `${REPO}/src/a.ts`

let seq = 0
const id = (): string => `toolu_${++seq}`

const prompt = (text = 'please fix the bug') => ({ type: 'user', message: { role: 'user', content: text } })

const assistant = (stop: string, ...content: object[]) => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: stop, content },
})

const text = (stop = 'end_turn', words = 'Done. Shall I open the PR?') =>
  assistant(stop, { type: 'text', text: words })

const toolUse = (name: string, input: object, toolId = id()) =>
  assistant('tool_use', { type: 'tool_use', id: toolId, name, input })

const result = (toolId: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
})

/** A tool call and its result, as two transcript records. */
const call = (name: string, input: object) => {
  const toolId = id()
  return [toolUse(name, input, toolId), result(toolId)]
}

const jsonl = (records: object[]): string => records.map(r => JSON.stringify(r)).join('\n')

describe('classifyWait', () => {
  it('an end_turn after an Edit to a still-dirty file is mid-episode, not awaiting', () => {
    const records = [prompt(), ...call('Edit', { file_path: FILE }), text()]

    expect(classifyWait(records, [FILE], [])).toEqual({ kind: 'mid-episode', reason: 'partial-edit' })
  })

  it('a commit later in the same turn clears the edit, so the turn end is awaiting', () => {
    const records = [
      prompt(),
      ...call('Edit', { file_path: FILE }),
      ...call('Bash', { command: 'git add -A && git commit -m "Fix it"' }),
      text(),
    ]

    expect(classifyWait(records, [FILE], [])).toEqual({ kind: 'awaiting-turn-end' })
  })

  it('a gh pr create later in the same turn clears the edit as well', () => {
    const records = [
      prompt(),
      ...call('Write', { file_path: FILE }),
      ...call('Bash', { command: 'gh pr create --fill' }),
      text(),
    ]

    expect(classifyWait(records, [FILE], [])).toEqual({ kind: 'awaiting-turn-end' })
  })

  it('an edit made after the commit is still partial', () => {
    const records = [
      prompt(),
      ...call('Bash', { command: 'git commit -am wip' }),
      ...call('Edit', { file_path: FILE }),
      text(),
    ]

    expect(classifyWait(records, [FILE], [])).toEqual({ kind: 'mid-episode', reason: 'partial-edit' })
  })

  it("a peer's dirt in a shared checkout does not count when this turn never touched it", () => {
    const records = [prompt(), ...call('Edit', { file_path: FILE }), text()]

    expect(classifyWait(records, [`${REPO}/src/peer.ts`], [])).toEqual({ kind: 'awaiting-turn-end' })
  })

  it('an edit in an earlier turn does not make the final turn partial', () => {
    const records = [prompt(), ...call('Edit', { file_path: FILE }), text(), prompt('thanks'), text()]

    expect(classifyWait(records, [FILE], [])).toEqual({ kind: 'awaiting-turn-end' })
  })

  it('counts a NotebookEdit by its notebook path', () => {
    const nb = `${REPO}/n.ipynb`
    const records = [prompt(), ...call('NotebookEdit', { notebook_path: nb }), text()]

    expect(classifyWait(records, [nb], [])).toEqual({ kind: 'mid-episode', reason: 'partial-edit' })
  })

  it('an unanswered AskUserQuestion is awaiting-ask', () => {
    const records = [prompt(), toolUse('AskUserQuestion', { questions: [] })]

    expect(classifyWait(records, [], [])).toEqual({ kind: 'awaiting-ask' })
  })

  it('an answered AskUserQuestion no longer counts as awaiting-ask', () => {
    const ask = id()
    const records = [prompt(), toolUse('AskUserQuestion', {}, ask), result(ask), text()]

    expect(classifyWait(records, [], [])).toEqual({ kind: 'awaiting-turn-end' })
  })

  it('an unanswered Bash tool_use is mid-episode with an open tool', () => {
    const records = [prompt(), toolUse('Bash', { command: 'npm test' })]

    expect(classifyWait(records, [], [])).toEqual({ kind: 'mid-episode', reason: 'open-tool' })
  })

  it('a spawned child that has not reported keeps the episode open', () => {
    const records = [prompt(), text()]

    expect(classifyWait(records, [], ['worker-1'])).toEqual({
      kind: 'mid-episode',
      reason: 'awaited-children',
    })
  })

  it('an unparseable tail is unknown, never awaiting', () => {
    expect(classifyWait(recordsOf('{"type":"assis\nnot json at all\n'), [], [])).toEqual({
      kind: 'unknown',
    })
  })

  it('a tool result with no reply yet is unknown, since the model is still generating', () => {
    const records = [prompt(), ...call('Bash', { command: 'ls' })]

    expect(classifyWait(records, [], [])).toEqual({ kind: 'unknown' })
  })

  it('ignores bookkeeping, meta and sidechain records after the turn end', () => {
    const records = [
      prompt(),
      text(),
      { type: 'system', subtype: 'stop_hook_summary' },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } },
      { ...toolUse('Bash', { command: 'sleep 9' }), isSidechain: true },
      { type: 'cost-state' },
    ]

    expect(classifyWait(records, [], [])).toEqual({ kind: 'awaiting-turn-end' })
  })
})

describe('recordsOf', () => {
  it('skips the cut first line of a tail and keeps whole records', () => {
    const tail = `ge":{"role":"user"}}\n${jsonl([prompt(), text()])}\n`

    expect(classifyWait(recordsOf(tail), [], [])).toEqual({ kind: 'awaiting-turn-end' })
  })
})

describe('parseDirtyPaths', () => {
  it('resolves porcelain -z entries against the repo root, taking the new side of a rename', () => {
    const porcelain = ' M src/a.ts\0R  new.ts\0old.ts\0?? dir/with space.ts\0'

    expect(parseDirtyPaths(porcelain, REPO)).toEqual([FILE, `${REPO}/new.ts`, `${REPO}/dir/with space.ts`])
  })
})

describe('readWait', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })

  /** A real repo with one committed file, and a config dir holding this session's transcript. */
  function fixture(records: (repo: string) => object[]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'human-wait-')))
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q')
    fs.writeFileSync(path.join(repo, 'a.ts'), 'one\n')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'init')
    const configDir = path.join(root, 'config')
    const transcript = transcriptPath(repo, 'sess-1', configDir)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, jsonl(records(repo)))
    return { repo, configDir }
  }

  const noChildren = {
    request: async (msg: { t: string }) =>
      msg.t === 'agents' ? { t: 'agents_result', agents: [] } : { t: 'activity_result', events: [] },
  } as never

  it('sees an edited, uncommitted file in a real checkout as a partial edit', async () => {
    const { repo, configDir } = fixture(r => [
      prompt(),
      ...call('Edit', { file_path: path.join(r, 'a.ts') }),
      text(),
    ])
    fs.writeFileSync(path.join(repo, 'a.ts'), 'two\n')

    const wait = await readWait({
      sessionId: 'sess-1',
      cwd: repo,
      configDir,
      self: 'coord',
      broker: noChildren,
    })

    expect(wait).toEqual({ kind: 'mid-episode', reason: 'partial-edit' })
  })

  it('is unknown when the session has written no transcript', async () => {
    const { repo, configDir } = fixture(() => [])

    const wait = await readWait({
      sessionId: 'missing',
      cwd: repo,
      configDir,
      self: null,
      broker: noChildren,
    })

    expect(wait).toEqual({ kind: 'unknown' })
  })
})

describe('awaitedChildren', () => {
  const SPAWNED_AT = 1_000
  const child = (name: string, state: AgentIdentity['state'] = 'live', spawnedBy = 'coord') =>
    ({ name, state, spawnedBy, spawnedAt: SPAWNED_AT }) as AgentIdentity
  const message = (from: string, body: string, at = SPAWNED_AT + 1, target = 'coord'): QueueItem => ({
    msgId: `m-${from}-${at}`,
    kind: 'message',
    from,
    text: body,
    at,
    meta: { target },
  })

  it('names live children with no Status: report since their spawn', () => {
    const agents = [child('w1'), child('w2'), child('w3', 'exited'), child('other', 'live', 'someone-else')]
    const activity = new Map([
      ['w1', [message('w1', 'Status: DONE\nPR: o/r#1')]],
      ['w2', [message('w2', 'halfway there'), message('w2', 'Status: DONE', SPAWNED_AT - 5)]],
    ])

    expect(awaitedChildren('coord', agents, activity)).toEqual(['w2'])
  })

  it('does not count a report sent to someone else', () => {
    const activity = new Map([['w1', [message('w1', 'Status: DONE', SPAWNED_AT + 1, 'peer')]]])

    expect(awaitedChildren('coord', [child('w1', 'spawning')], activity)).toEqual(['w1'])
  })
})
