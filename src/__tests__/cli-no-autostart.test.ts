import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: () => undefined })))
vi.mock('node:child_process', async orig => ({ ...(await orig<object>()), spawn: spawnMock }))

import { BROKER_UNAVAILABLE_EXIT, BrokerUnavailableError, withBroker } from '../cli/client.js'
import type { VerbContext } from '../cli/command.js'
import { agentResume } from '../cli/verbs/agent-resume.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-noauto-'))
  process.env.AGENT_CHAT_HOME = home
  spawnMock.mockClear()
})
afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_NO_AUTOSTART
  fs.rmSync(home, { recursive: true, force: true })
})

describe('AGENT_CHAT_NO_AUTOSTART', () => {
  it('fails with a typed broker-unavailable error and never spawns a broker', async () => {
    process.env.AGENT_CHAT_NO_AUTOSTART = '1'
    const err = await withBroker(async () => 'ran').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerUnavailableError)
    expect((err as BrokerUnavailableError).code).toBe(BROKER_UNAVAILABLE_EXIT)
    expect((err as Error).message).toMatch(/^broker unavailable/)
    expect((err as Error).message).not.toContain('\n')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('keeps autostarting when the variable is unset', async () => {
    const attempt = withBroker(async () => 'ran')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    attempt.catch(() => undefined)
  })

  it('does not treat values other than 1 as set', async () => {
    process.env.AGENT_CHAT_NO_AUTOSTART = 'true'
    const attempt = withBroker(async () => 'ran')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    attempt.catch(() => undefined)
  })
})

describe('agent resume --message-stdin', () => {
  const sent: unknown[] = []
  const ctx = {
    warnings: [],
    format: 'human',
    withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
      fn({
        request: async (m: unknown) => {
          sent.push(m)
          return { t: 'spawn_result', ok: true, name: 'w' }
        },
      }),
  } as unknown as VerbContext

  const pipe = (text: string) =>
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([Buffer.from(text)]) as never)

  beforeEach(() => {
    sent.length = 0
  })
  afterEach(() => vi.restoreAllMocks())

  it('passes the stdin text through as the message', async () => {
    pipe('wake up\nsecond line')
    await agentResume.run({ name: 'w', messageStdin: true }, ctx)
    expect(sent[0]).toMatchObject({ t: 'resume', name: 'w', message: 'wake up\nsecond line' })
  })

  it('rejects a message argument alongside --message-stdin', async () => {
    await expect(agentResume.run({ name: 'w', message: 'x', messageStdin: true }, ctx)).rejects.toThrow(
      /do not also pass --message/,
    )
    expect(sent).toEqual([])
  })

  it('rejects empty stdin', async () => {
    pipe('  \n')
    await expect(agentResume.run({ name: 'w', messageStdin: true }, ctx)).rejects.toThrow(/empty message/)
    expect(sent).toEqual([])
  })
})
