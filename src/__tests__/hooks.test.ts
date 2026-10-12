import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runHooks, type HookProcess, type HookSpawnFn } from '../agents/hooks.js'

/**
 * CC-71 — the generic agent-lifecycle hook mechanism. `runHooks` is tested with
 * an injected `HookSpawnFn` (matching the house `SpawnFn` convention in
 * `agents/surfaces/options.ts`) so these tests never launch a real shell.
 */

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hooks-'))
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeHooksJson(config: unknown): void {
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify(config))
}

interface Captured {
  command: string
  cwd: string
  stdin: string
}

function capturingSpawn(): { spawn: HookSpawnFn; calls: Captured[] } {
  const calls: Captured[] = []
  const spawn: HookSpawnFn = (command, cwd) => {
    const call: Captured = { command, cwd, stdin: '' }
    calls.push(call)
    const proc: HookProcess = {
      stdin: {
        write: chunk => {
          call.stdin += chunk
        },
        end: () => undefined,
      },
      on: () => undefined,
    }
    return proc
  }
  return { spawn, calls }
}

describe('runHooks', () => {
  it('is a no-op when hooks.json does not exist', () => {
    const { spawn, calls } = capturingSpawn()
    expect(() => runHooks('on_spawn', { agentId: 'a1' }, { spawn })).not.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('is a no-op when hooks.json is malformed JSON', () => {
    fs.writeFileSync(path.join(dir, 'hooks.json'), '{ not json')
    const { spawn, calls } = capturingSpawn()
    expect(() => runHooks('on_spawn', { agentId: 'a1' }, { spawn })).not.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('is a no-op for an event with no registered commands', () => {
    writeHooksJson({ on_complete: ['echo hi'] })
    const { spawn, calls } = capturingSpawn()
    runHooks('on_spawn', { agentId: 'a1' }, { spawn })
    expect(calls).toHaveLength(0)
  })

  it('invokes every registered command for the event, piping the payload as JSON on stdin', () => {
    writeHooksJson({ on_spawn: ['/bin/first.sh', '/bin/second.sh'], on_complete: ['/bin/exit.sh'] })
    const { spawn, calls } = capturingSpawn()

    runHooks('on_spawn', { agentId: 'a1', cwd: '/tmp/x' }, { spawn })

    expect(calls.map(c => c.command)).toEqual(['/bin/first.sh', '/bin/second.sh'])
    for (const call of calls) {
      expect(JSON.parse(call.stdin)).toEqual({ agentId: 'a1', cwd: '/tmp/x' })
    }
  })

  it('does not throw when a hook process errors, and logs instead of crashing the caller', () => {
    writeHooksJson({ on_complete: ['/bin/broken.sh'] })
    let errorListener: ((err: Error) => void) | undefined
    const spawn: HookSpawnFn = () => ({
      stdin: { write: () => undefined, end: () => undefined },
      on: (event, listener) => {
        if (event === 'error') errorListener = listener
      },
    })

    expect(() => runHooks('on_complete', { agentId: 'a1' }, { spawn })).not.toThrow()
    expect(() => errorListener?.(new Error('spawn failed'))).not.toThrow()
  })

  it('does not throw when the injected spawn function itself throws', () => {
    writeHooksJson({ on_spawn: ['/bin/boom.sh'] })
    const spawn: HookSpawnFn = () => {
      throw new Error('boom')
    }
    expect(() => runHooks('on_spawn', { agentId: 'a1' }, { spawn })).not.toThrow()
  })
})

/**
 * A hook command that does not exist leaves a stdin pipe with no reader, and the
 * EPIPE that write produces arrives asynchronously — past the try/catch, out as
 * an unhandled rejection in whatever the broker was doing at the time. Found
 * while making an exit close its pane (CC-95), which widened the window enough
 * for it to land inside a test run.
 */
describe('a hook child that dies before reading its stdin', () => {
  it('does not let the pipe error escape as an unhandled rejection', async () => {
    writeHooksJson({ on_complete: ['exit 0'] })
    const rejections: unknown[] = []
    const onRejection = (err: unknown): void => void rejections.push(err)
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onRejection)

    // Past the ~64KB pipe buffer, so the write is still in flight when the child
    // is already gone. A small payload lands in the buffer and never faults.
    runHooks('on_complete', { agentId: 'a'.repeat(1024 * 1024) })
    await new Promise(resolve => setTimeout(resolve, 500))

    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onRejection)
    expect(rejections).toEqual([])
  })
})

/**
 * CC-1096: the broker once ran from an agent worktree that was later parked, and
 * every hook it spawned failed with `uv_cwd` (1057 broker.log rows). A hook runs
 * in the agent's cwd while that exists and in HOME otherwise.
 */
describe('the cwd a hook runs in', () => {
  it("is the payload's cwd when that directory exists", () => {
    writeHooksJson({ on_spawn: ['/bin/hook.sh'] })
    const { spawn, calls } = capturingSpawn()

    runHooks('on_spawn', { agentId: 'a1', cwd: dir }, { spawn })

    expect(calls.map(c => c.cwd)).toEqual([dir])
  })

  it("falls back to HOME when the payload's cwd was removed", () => {
    writeHooksJson({ on_complete: ['/bin/hook.sh'] })
    const removed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hooks-gone-'))
    fs.rmSync(removed, { recursive: true })
    const { spawn, calls } = capturingSpawn()

    runHooks('on_complete', { agentId: 'a1', cwd: removed }, { spawn })

    expect(calls.map(c => c.cwd)).toEqual([os.homedir()])
  })

  it('is HOME when the payload names no cwd', () => {
    writeHooksJson({ on_complete: ['/bin/hook.sh'] })
    const { spawn, calls } = capturingSpawn()

    runHooks('on_complete', { agentId: 'a1' }, { spawn })

    expect(calls.map(c => c.cwd)).toEqual([os.homedir()])
  })

  it('reaches a real shell: pwd in a hook for a removed tree prints HOME', async () => {
    const out = path.join(dir, 'out')
    writeHooksJson({ on_complete: [`pwd > '${out}'`] })
    const removed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hooks-gone-'))
    fs.rmSync(removed, { recursive: true })

    runHooks('on_complete', { agentId: 'a1', cwd: removed })

    const printed = await pollFile(out, 5000)
    expect(fs.realpathSync(printed.trim())).toBe(fs.realpathSync(os.homedir()))
  })
})

async function pollFile(file: string, capMs: number): Promise<string> {
  const deadline = Date.now() + capMs
  while (Date.now() < deadline) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (text.endsWith('\n')) return text
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${file} was not written within ${capMs} ms`)
}
