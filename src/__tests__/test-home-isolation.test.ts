import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { logPath } from '../paths.js'

const realLog = path.join(os.homedir(), '.agent-chat', 'broker.log')

describe('test home isolation (CC-1461)', () => {
  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
  })

  it('points the broker log away from the real home before any spec hook runs', () => {
    expect(logPath()).not.toBe(realLog)
    expect(logPath().startsWith(process.env.TEST_HOME_ROOT ?? os.tmpdir())).toBe(true)
  })

  it('keeps the broker log off the real home after a spec hook unset the home', () => {
    expect(process.env.AGENT_CHAT_HOME).toBeDefined()
    expect(logPath()).not.toBe(realLog)
  })
})
