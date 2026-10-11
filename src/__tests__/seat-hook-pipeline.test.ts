import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let stdin = ''
vi.mock('../cli/verbs/permission-hook.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/verbs/permission-hook.js')>()),
  readStdin: async (): Promise<string> => stdin,
}))

const { buildHookSettings } = await import('../agents/launch-files.js')
const { buildProgram } = await import('../cli/index.js')
const { EventLog } = await import('../broker/event-log.js')

interface Installed {
  event: string
  phase: string
  matcher: string | undefined
}

/** Every seat-hook command the launch settings install, as Claude Code would find it. */
function installedSeatHooks(): Installed[] {
  const hooks = buildHookSettings('/x/cli.js', undefined, undefined, 'a1').hooks as Record<
    string,
    { matcher?: string; hooks: { command: string }[] }[]
  >
  return Object.entries(hooks).flatMap(([event, entries]) =>
    entries.flatMap(entry =>
      entry.hooks.flatMap(hook => {
        const phase = / seat-hook (\S+)$/.exec(hook.command)?.[1]
        return phase === undefined ? [] : [{ event, phase, matcher: entry.matcher }]
      }),
    ),
  )
}

/** The payload Claude Code sends for `event`, for a call that matches the hook's matcher. */
const payload = (event: string, matcher: string | undefined): string =>
  JSON.stringify({
    session_id: 's1',
    hook_event_name: event,
    ...(event.endsWith('ToolUse') ? { tool_name: matcher ?? 'AskUserQuestion' } : {}),
  })

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-hook-pipeline-'))
  process.env.AGENT_CHAT_HOME = dir
  process.env.AGENT_CHAT_NAME = 'coord'
})
afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_NAME
  fs.rmSync(dir, { recursive: true, force: true })
})

async function run(phase: string, input: string): Promise<void> {
  stdin = input
  await buildProgram().parseAsync(['node', 'agent-chat', 'seat-hook', phase])
}

const kinds = (): string[] => {
  const log = new EventLog()
  try {
    return log.seatBlockRows(0, Date.now() + 60_000).map(row => row.kind)
  } finally {
    log.close()
  }
}

describe('the installed seat hooks, run through the CLI', () => {
  it('installs a hook for the question, its answer, a prompt, a stop and a session end', () => {
    const events = installedSeatHooks().map(h => `${h.event}:${h.phase}`)

    expect(events.sort()).toEqual(
      ['PostToolUse:post', 'PreToolUse:pre', 'SessionEnd:end', 'Stop:end', 'UserPromptSubmit:end'].sort(),
    )
  })

  it('writes a block from the pre hook and an unblock from the post hook', async () => {
    await run('pre', payload('PreToolUse', 'AskUserQuestion'))
    await run('post', payload('PostToolUse', 'AskUserQuestion'))

    expect(kinds()).toEqual(['seat_blocked', 'seat_unblocked'])
  })

  it.each(['UserPromptSubmit', 'Stop', 'SessionEnd'])(
    'closes a block left open when %s fires with no tool call',
    async event => {
      const hook = installedSeatHooks().find(h => h.event === event)
      await run('pre', payload('PreToolUse', 'AskUserQuestion'))

      await run(hook?.phase ?? 'missing', payload(event, hook?.matcher))

      expect(kinds()).toEqual(['seat_blocked', 'seat_unblocked'])
    },
  )

  it('writes nothing for a session with no seat name, and never throws on a bad payload', async () => {
    delete process.env.AGENT_CHAT_NAME
    await run('pre', payload('PreToolUse', 'AskUserQuestion'))
    process.env.AGENT_CHAT_NAME = 'coord'

    await expect(run('pre', 'not json')).resolves.toBeUndefined()
    await expect(run('bogus', payload('PreToolUse', 'AskUserQuestion'))).resolves.toBeUndefined()

    expect(kinds()).toEqual([])
  })
})
