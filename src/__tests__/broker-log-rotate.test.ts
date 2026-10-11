import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
const log = () => path.join(dir, 'broker.log')

async function freshLogger() {
  vi.resetModules()
  return import('../broker/log.js')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-log-rotate-'))
  process.env.AGENT_CHAT_HOME = dir
  process.env.AGENT_CHAT_BROKER_LOG_MAX_BYTES = '100'
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_BROKER_LOG_MAX_BYTES
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('broker.log rotation', () => {
  it('moves an oversize log to .1 and writes the new line to a fresh file', async () => {
    fs.writeFileSync(log(), 'old-content-'.repeat(20))
    const { logEvent } = await freshLogger()

    logEvent('after-cap')

    expect(fs.readFileSync(`${log()}.1`, 'utf8')).toBe('old-content-'.repeat(20))
    const fresh = fs.readFileSync(log(), 'utf8').trim().split('\n')
    expect(fresh).toHaveLength(1)
    expect(JSON.parse(fresh[0] ?? '').event).toBe('after-cap')
  })

  it('replaces an existing .1', async () => {
    fs.writeFileSync(`${log()}.1`, 'ancient')
    fs.writeFileSync(log(), 'x'.repeat(200))
    const { logEvent } = await freshLogger()

    logEvent('e')

    expect(fs.readFileSync(`${log()}.1`, 'utf8')).toBe('x'.repeat(200))
  })

  it('does not rotate below the cap', async () => {
    fs.writeFileSync(log(), 'small')
    const { logEvent } = await freshLogger()

    logEvent('e')

    expect(fs.existsSync(`${log()}.1`)).toBe(false)
    expect(fs.readFileSync(log(), 'utf8')).toMatch(/^small\{/)
  })

  it('does not stat on every append', async () => {
    const { logEvent } = await freshLogger()
    const stat = vi.spyOn(fs, 'statSync')

    logEvent('a')
    logEvent('b')
    logEvent('c')

    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('checks again after 256 KiB of writes', async () => {
    process.env.AGENT_CHAT_BROKER_LOG_MAX_BYTES = String(300 * 1024)
    const { logEvent } = await freshLogger()

    logEvent('big', { pad: 'p'.repeat(300 * 1024) })
    logEvent('next')

    expect(fs.existsSync(`${log()}.1`)).toBe(true)
    expect(fs.readFileSync(log(), 'utf8')).toMatch(/"event":"next"/)
  })

  it('survives a concurrent rotation that removes the file before rename', async () => {
    fs.writeFileSync(log(), 'x'.repeat(200))
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      fs.unlinkSync(from)
      return realRename(from, to)
    })
    const { logEvent, loggedCount } = await freshLogger()

    expect(() => logEvent('raced')).not.toThrow()

    expect(loggedCount('raced')).toBe(1)
    expect(fs.readFileSync(log(), 'utf8')).toMatch(/"event":"raced"/)
  })
})
