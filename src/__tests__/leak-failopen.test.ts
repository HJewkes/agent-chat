import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type * as LeakPretool from '../cli/verbs/leak-pretool.js'
import { decideWithin, failOpenLogger, type Deadline } from '../leak-guard/failopen.js'
import {
  crashDenial,
  pretoolDecision,
  REASONS,
  timeoutDenial,
  type GuardContext,
} from '../leak-guard/pretool.js'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-failopen-'))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const lines = (file: string): string[] => fs.readFileSync(file, 'utf8').trim().split('\n')

const within = (ms: number): Deadline => ({ ms, denial: timeoutDenial })

describe('every fail-open of the pretool hook writes one log line naming the cause', () => {
  it('logs a crash with the error class, and allows the call', () => {
    const file = path.join(SCRATCH, 'crash.log')
    const build = (): GuardContext => {
      throw new RangeError('boom')
    }
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/work' })

    expect(pretoolDecision(raw, build, failOpenLogger(file))).toBe('')

    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]).toMatch(/leak-guard pretool fail-open: crash \(RangeError\)$/)
  })

  it('denies a decision that runs past the deadline, unlogged, telling the agent to split the command', async () => {
    const file = path.join(SCRATCH, 'timeout.log')

    const out = await decideWithin(
      () => new Promise<string>(() => undefined),
      within(20),
      failOpenLogger(file),
    )

    expect(JSON.parse(out).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASONS.checkTimeout,
    })
    expect(REASONS.checkTimeout).toContain('Split the command into smaller Bash calls')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('logs a rejected decision as one crash, and passes a timely answer through unlogged', async () => {
    const file = path.join(SCRATCH, 'mixed.log')
    const log = failOpenLogger(file)

    expect(await decideWithin(async () => 'deny', within(1000), log)).toBe('deny')
    expect(fs.existsSync(file)).toBe(false)
    expect(await decideWithin(() => Promise.reject(new TypeError('x')), within(1000), log)).toBe('')
    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]).toMatch(/crash \(TypeError\)$/)
  })
})

describe('a worker that fails to run', () => {
  const failing = (): Promise<string> => Promise.reject(new Error('worker did not start'))

  it('denies a git or gh call, unlogged, as the in-process crash does', async () => {
    const file = path.join(SCRATCH, 'worker-git.log')
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --no-verify' } })

    const out = await decideWithin(failing, within(1000), failOpenLogger(file), () => crashDenial(raw))

    expect(out).toContain('"permissionDecision":"deny"')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('allows any other call with one crash line', async () => {
    const file = path.join(SCRATCH, 'worker-ls.log')
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

    const out = await decideWithin(failing, within(1000), failOpenLogger(file), () => crashDenial(raw))

    expect(out).toBe('')
    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]).toMatch(/fail-open: crash \(Error\)$/)
  })
})

describe('a Bash line padded so its check outruns the deadline (CC-1407)', () => {
  // The built module, so the decision runs in the real worker thread the hook uses.
  const load = (): Promise<typeof LeakPretool> =>
    import(path.resolve(import.meta.dirname, '../../dist/cli/verbs/leak-pretool.js'))
  const padded = (kb: number): string => {
    const unit = 'echo a; ls b; '
    const body = unit.repeat(Math.ceil((kb * 1024) / unit.length))
    return `echo \`${body}\`; git push --no-verify origin main`
  }
  const input = (command: string): string =>
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: SCRATCH })

  it('is denied within the deadline plus a small margin, not allowed', async () => {
    const { decidePretool } = await load()
    const deadlineMs = 250
    const started = Date.now()

    const out = await decidePretool(input(padded(200)), path.join(SCRATCH, 'padded.log'), deadlineMs)

    expect(Date.now() - started).toBeLessThan(deadlineMs + 1_500)
    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toBe(REASONS.checkTimeout)
  })

  it('leaves an ordinary line to the check itself', async () => {
    const { decidePretool } = await load()

    expect(await decidePretool(input('ls -la'), path.join(SCRATCH, 'plain.log'))).toBe('')
  })
})
