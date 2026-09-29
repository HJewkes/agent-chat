import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { start } from '../cli/service.js'

/**
 * CC-193: macOS reports a lost bind race as EEXIST where Linux says EADDRINUSE, and
 * nothing produces EEXIST on demand. The listen step is faked so the loser's exit
 * path is observed without standing up a competing broker.
 */

const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac-cc193-'))
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  process.exitCode = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

function failListenWith(code: string): void {
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error(`listen ${code}`), { code })))
    return this
  })
}

const logLines = (): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(dir, 'broker.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)

describe('a broker that loses the bind with EEXIST', () => {
  it('exits cleanly with the already-listening message and never opens events.db', async () => {
    failListenWith('EEXIST')
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`exit ${code}`)
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await start({ foreground: true, port: 0 })

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('a broker is already listening'))
    expect(exit).not.toHaveBeenCalled()
    expect(process.exitCode ?? 0).toBe(0)
    expect(logLines().map(line => [line.event, line.reason])).toContainEqual([
      'broker_exit',
      'another broker is already listening',
    ])
    expect(fs.existsSync(path.join(dir, 'events.db'))).toBe(false)
  })
})
