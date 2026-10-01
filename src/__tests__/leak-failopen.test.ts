import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decideWithin, failOpenLogger } from '../leak-guard/failopen.js'
import { crashDenial, pretoolDecision, type GuardContext } from '../leak-guard/pretool.js'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-failopen-'))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const lines = (file: string): string[] => fs.readFileSync(file, 'utf8').trim().split('\n')

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

  it('logs a timeout with the elapsed ms, and allows the call', async () => {
    const file = path.join(SCRATCH, 'timeout.log')

    const out = await decideWithin(() => new Promise<string>(() => undefined), 20, failOpenLogger(file))

    expect(out).toBe('')
    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]).toMatch(/leak-guard pretool fail-open: timeout after \d+ms$/)
  })

  it('logs a rejected decision as one crash, and passes a timely answer through unlogged', async () => {
    const file = path.join(SCRATCH, 'mixed.log')
    const log = failOpenLogger(file)

    expect(await decideWithin(async () => 'deny', 1000, log)).toBe('deny')
    expect(fs.existsSync(file)).toBe(false)
    expect(await decideWithin(() => Promise.reject(new TypeError('x')), 1000, log)).toBe('')
    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]).toMatch(/crash \(TypeError\)$/)
  })
})

describe('a worker that fails to run', () => {
  const failing = (): Promise<string> => Promise.reject(new Error('worker did not start'))

  it('denies a git or gh call, unlogged, as the in-process crash does', async () => {
    const file = path.join(SCRATCH, 'worker-git.log')
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --no-verify' } })

    const out = await decideWithin(failing, 1000, failOpenLogger(file), () => crashDenial(raw))

    expect(out).toContain('"permissionDecision":"deny"')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('allows any other call with one crash line', async () => {
    const file = path.join(SCRATCH, 'worker-ls.log')
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

    const out = await decideWithin(failing, 1000, failOpenLogger(file), () => crashDenial(raw))

    expect(out).toBe('')
    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]).toMatch(/fail-open: crash \(Error\)$/)
  })
})
