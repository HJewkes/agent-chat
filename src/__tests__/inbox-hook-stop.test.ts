import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHookSettings } from '../agents/launch-files.js'
import { EventLog } from '../broker/event-log.js'
import { inboxSpoolDir, spoolRecord, type SpoolRecord } from '../server/inbox-spool.js'

/**
 * CC-1455 S6: the installed Stop entry blocks a print run's turn end once to show what
 * is waiting, and never on the re-entry, so the turn still ends. Runs the exact Stop
 * command from the generated settings under `sh -c` against the built `dist/cli.js`.
 * Every name and id is synthetic.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const AGENT = 'ag0000x6'

interface HookEntry {
  hooks: Array<{ command: string }>
}

let dir: string
beforeEach(() => {
  expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1455-stop-'))
  vi.stubEnv('AGENT_CHAT_HOME', dir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

const direct = (msgId: string): SpoolRecord => ({
  kind: 'message',
  msgId,
  meta: { from: 'impl', msg_id: msgId },
  text: `stand down ${msgId}`,
})

function installed(event: 'Stop' | 'PostToolUse'): string {
  const hooks = (
    buildHookSettings(CLI, undefined, undefined, AGENT) as { hooks: Record<string, HookEntry[]> }
  ).hooks
  return hooks[event]!.flatMap(entry => entry.hooks).find(hook => hook.command.includes(' inbox-hook '))!
    .command
}

function runInstalled(event: 'Stop' | 'PostToolUse', payload: Record<string, unknown>): string {
  const run = spawnSync('sh', ['-c', installed(event)], {
    input: JSON.stringify({ hook_event_name: event, session_id: 'sess-1', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_CHAT_HOME: dir, AGENT_CHAT_NAME: 'agent-x' },
  })
  expect(run.status).toBe(0)
  return run.stdout
}

const stop = (active: boolean): string => runInstalled('Stop', { stop_hook_active: active })

const spooled = (): string[] => {
  const inbox = inboxSpoolDir(AGENT)
  return fs.existsSync(inbox) ? fs.readdirSync(inbox).filter(name => name.endsWith('.json')) : []
}

function shownRows(): { actor: string; ref: string; meta: string }[] {
  if (!fs.existsSync(path.join(dir, 'events.db'))) return []
  const log = new EventLog(path.join(dir, 'events.db'))
  try {
    return log
      .ledgerHandle()
      .prepare("SELECT actor, ref, meta FROM events WHERE kind = 'inbox_shown'")
      .all() as { actor: string; ref: string; meta: string }[]
  } finally {
    log.close()
  }
}

describe('the installed Stop inbox hook', () => {
  it('blocks the turn end with the spooled message as the reason', () => {
    // Arrange
    spoolRecord(inboxSpoolDir(AGENT), direct('m-1'))

    // Act
    const out = stop(false)

    // Assert
    const verdict = JSON.parse(out) as { decision: string; reason: string }
    expect(verdict.decision).toBe('block')
    expect(verdict.reason).toContain('<channel source="agent-chat" from="impl" msg_id="m-1">')
    expect(verdict.reason).toContain('stand down m-1')
    expect(spooled()).toEqual([])
  })

  // Mutation: blocking whenever stop_hook_active is set, or ignoring it, loops the turn end.
  it('prints nothing on the re-entry even with a record spooled, so the turn ends', () => {
    // Arrange
    spoolRecord(inboxSpoolDir(AGENT), direct('m-1'))

    // Act
    const out = stop(true)

    // Assert
    expect(out).toBe('')
    expect(spooled()).toHaveLength(1)
    expect(shownRows()).toEqual([])
  })

  it('prints nothing at a turn end with an empty spool', () => {
    fs.mkdirSync(inboxSpoolDir(AGENT), { recursive: true })
    expect(stop(false)).toBe('')
    expect(shownRows()).toEqual([])
  })

  it('fails open: a record it cannot render never blocks the turn end', () => {
    fs.mkdirSync(inboxSpoolDir(AGENT), { recursive: true })
    fs.writeFileSync(path.join(inboxSpoolDir(AGENT), '0001.json'), '{"kind":"message"}')
    fs.writeFileSync(path.join(inboxSpoolDir(AGENT), '0002.json'), 'not json')
    expect(stop(false)).toBe('')
  })

  it('claims and receipts a block drain, so the next drain shows nothing', () => {
    // Arrange
    spoolRecord(inboxSpoolDir(AGENT), direct('m-1'))
    spoolRecord(inboxSpoolDir(AGENT), direct('m-2'))

    // Act
    const blocked = stop(false)
    const reentry = stop(true)
    const nextTool = runInstalled('PostToolUse', { tool_name: 'Bash' })

    // Assert
    expect(JSON.parse(blocked)).toMatchObject({ decision: 'block' })
    expect(reentry).toBe('')
    expect(nextTool).toBe('')
    const rows = shownRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'agent-x', ref: 'sess-1' })
    expect(JSON.parse(rows[0]!.meta)).toEqual({ msgIds: 'm-1,m-2' })
  })
})
