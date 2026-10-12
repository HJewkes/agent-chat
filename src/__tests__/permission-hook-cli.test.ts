import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync, spawn } from 'node:child_process'
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
  const input = { ...HOOK_INPUT, tool_input: { ...HOOK_INPUT.tool_input, command: `echo ${marker}` } }
  return runHookWith(input, ['--deadline', String(deadline)])
}

function runHookWith(input: object, args: string[]): HookRun {
  const child = spawn(process.execPath, [CLI, 'permission-hook', ...args], { env: ENV })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
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

  it('withdraws its row and prints a deny decision naming the deadline when it passes', async () => {
    const hook = runHook('late-marker', 2)
    await waitForRow('late-marker')

    const { code, stdout } = await hook.done
    const { stdout: inbox } = await cli(['inbox'])

    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: 'The owner did not answer in time (agent-chat permission-hook deadline).',
        },
      },
    })
    expect(inbox).not.toContain('late-marker')
  }, 20_000)
})

/** CC-694: a spawn armed with its linked worktree answers its own repo skill writes. */
describe('the permission-hook verb with --self-grant-skills', () => {
  const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

  /** A linked worktree made by `git worktree add`, so git itself registers it. */
  function linkedWorktree(): string {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(TEST_HOME, 'repo-')))
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        stdio: 'ignore',
      })
    }
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const root = path.join(repo, 'wt')
    git('worktree', 'add', '-q', root)
    return fs.realpathSync(root)
  }

  const writeInput = (filePath: string, marker: string) => ({
    ...HOOK_INPUT,
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: marker },
  })

  it('prints allow for a skill write in its own worktree and files no prompt', async () => {
    const root = linkedWorktree()
    const skillFile = path.join(root, '.claude', 'skills', 'probe', 'SKILL.md')

    const hook = runHookWith(writeInput(skillFile, 'grant-marker'), [
      '--deadline',
      '30',
      '--self-grant-skills',
      root,
    ])
    const { code, stdout } = await hook.done
    const { stdout: inbox } = await cli(['inbox'])

    expect(code).toBe(0)
    expect(stdout).toBe(ALLOW)
    expect(inbox).not.toContain('probe/SKILL.md')
  }, 20_000)

  it('still files a prompt for a write outside the skills subtree', async () => {
    const root = linkedWorktree()
    const settings = path.join(root, '.claude', 'settings.json')

    const hook = runHookWith(writeInput(settings, 'ungranted-marker'), [
      '--deadline',
      '30',
      '--self-grant-skills',
      root,
    ])
    const id = await waitForRow(settings)
    await cli(['approve', id, 'deny'])
    const { code, stdout } = await hook.done

    expect(code).toBe(0)
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('deny')
  }, 20_000)
})
