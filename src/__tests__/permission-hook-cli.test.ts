import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reapBroker } from './broker-harness.js'

/**
 * CC-144: `agent-chat permission-hook` as Claude Code runs it. Hook JSON on stdin, a
 * human answering from `agent-chat approve`, and the exact stdout the hook prints.
 */

const execFileAsync = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hookcli-'))
const ENV = { ...process.env, AGENT_CHAT_HOME: TEST_HOME, AGENT_CHAT_NAME: 'scout' }

const HOOK_INPUT = {
  session_id: 'f91c0f3a-4584-4587-ae63-c298d242728a',
  cwd: '/tmp/work',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'date > hello.txt', description: 'Create hello.txt' },
}

interface HookRun {
  done: Promise<{ code: number | null; stdout: string }>
}

const cli = (args: string[]) => execFileAsync(process.execPath, [CLI, ...args], { env: ENV })

function runHook(marker: string, deadline = 30): HookRun {
  const child = spawn(process.execPath, [CLI, 'permission-hook', '--deadline', String(deadline)], {
    env: ENV,
  })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  const input = { ...HOOK_INPUT, tool_input: { ...HOOK_INPUT.tool_input, command: `echo ${marker}` } }
  child.stdin.end(JSON.stringify(input))
  return { done: new Promise(resolve => child.on('exit', code => resolve({ code, stdout }))) }
}

/** Polls `inbox` until an APPR row whose preview carries `marker` appears, and returns its id. */
async function waitForRow(marker: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { stdout } = await cli(['inbox'])
    let current = ''
    for (const line of stdout.split('\n')) {
      const header = /^APPR\s+(\S+)/.exec(line)
      if (header) current = header[1]!
      else if (current && line.includes(marker)) return current
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`no APPR row for ${marker}`)
}

beforeAll(async () => {
  expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)
  // One caller starts the broker, so the hook and `inbox` never race to spawn two.
  await cli(['inbox'])
}, 30_000)

afterAll(async () => {
  await reapBroker(TEST_HOME)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('the permission-hook verb', () => {
  it('prints the documented allow decision once the human allows', async () => {
    const hook = runHook('allow-marker')
    const id = await waitForRow('allow-marker')
    const { stdout: listing } = await cli(['inbox'])

    await cli(['approve', id, 'allow'])
    const { code, stdout } = await hook.done

    // A headless agent has no terminal, so the footer must not send the human to one.
    expect(listing).toContain('scout blocked on a permission prompt — answer here.')
    expect(code).toBe(0)
    expect(stdout).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    )
  }, 20_000)

  it('prints a deny decision with a message once the human denies', async () => {
    const hook = runHook('deny-marker')
    const id = await waitForRow('deny-marker')

    await cli(['approve', id, 'deny'])
    const { code, stdout } = await hook.done

    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'The owner denied this tool call in agent-chat.' },
      },
    })
  }, 20_000)

  it('withdraws its row and exits non-zero with no decision when its deadline passes', async () => {
    const hook = runHook('late-marker', 2)
    await waitForRow('late-marker')

    const { code, stdout } = await hook.done
    const { stdout: inbox } = await cli(['inbox'])

    expect(code).not.toBe(0)
    expect(stdout).toBe('')
    expect(inbox).not.toContain('late-marker')
  }, 20_000)
})
