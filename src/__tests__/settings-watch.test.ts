import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { FileRecord, Records } from '../leak-guard/integrity/record.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/** TP-4256 A5: the broker re-hashes the settings.json it wrote. Names, ids and paths are synthetic. */

const NONCE = 'c'.repeat(64)
const ZSHRC = '/home/example/.zshrc'
const WITH_HOOK = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] },
})
const TICK_MS = 60_000
const dirs: string[] = []
const servers: SocketServer[] = []

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const zshrc: FileRecord = {
  kind: 'startup',
  state: 'present',
  lstat: { dev: '1', ino: '5', size: '3', ctimeNs: '50' },
  sha256: 'h1',
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-settings-watch-'))
  dirs.push(dir)
  const settings = path.join(dir, 'settings.json')
  fs.writeFileSync(settings, WITH_HOOK)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  core.append({ kind: 'agent_spawned', actor: 'coord', target: 'scout', msgId: 'a1', body: 'work' })
  const server = new SocketServer(core)
  servers.push(server)
  server.integrity.registerLaunch(NONCE, 'a1', { [ZSHRC]: zshrc })
  server.settingsWatch.register(NONCE, settings)
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  const check = (): ServerMessage | undefined => {
    const records: Records = { [ZSHRC]: zshrc }
    server.handleMessage(conn, {
      t: 'integrity_check',
      nonce: NONCE,
      session: 's1',
      records,
    } as ClientMessage)
    return frames.at(-1)
  }
  const notices = () => core.events.since(0, 500).filter(row => row.kind === 'notice')
  return { settings, check, notices, server }
}

describe('settings-watch', () => {
  it('quarantines and files one notice when the hook is dropped and no later call comes', () => {
    const { settings, check, notices } = setup()

    fs.writeFileSync(settings, JSON.stringify({ hooks: {} }))
    vi.advanceTimersByTime(TICK_MS)
    vi.advanceTimersByTime(TICK_MS)

    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toMatchObject({ meta: { file: settings, field: 'sha256', agent: 'scout' } })
    expect(check()).toMatchObject({ ok: false, reason: 'quarantined', file: settings })
    expect(notices()).toHaveLength(1)
  })

  it('quarantines when the file is deleted', () => {
    const { settings, check, notices } = setup()

    fs.rmSync(settings)
    vi.advanceTimersByTime(TICK_MS)

    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toMatchObject({ meta: { file: settings, field: 'state' } })
    expect(check()).toMatchObject({ ok: false, reason: 'quarantined' })
  })

  it('quarantines on the next integrity_check without waiting for the timer', () => {
    const { settings, check } = setup()

    fs.writeFileSync(settings, JSON.stringify({ hooks: {} }))

    expect(check()).toMatchObject({ ok: false, reason: 'quarantined', file: settings })
  })

  it("detects a rewrite of a sibling's settings.json made outside pretool and quarantines the sibling", () => {
    const { settings, check, notices, server } = setup()
    const sibling = path.join(path.dirname(settings), 'sibling-settings.json')
    const siblingNonce = 'f'.repeat(64)
    fs.copyFileSync(settings, sibling)
    server.integrity.registerLaunch(siblingNonce, 'a1', { [ZSHRC]: zshrc })
    server.settingsWatch.register(siblingNonce, sibling)

    fs.appendFileSync(sibling, ' ')
    server.settingsWatch.sweep()

    expect(server.integrity.check(siblingNonce, 's1', { [ZSHRC]: zshrc })).toMatchObject({
      reason: 'quarantined',
      file: sibling,
    })
    expect(notices()).toHaveLength(1)
    expect(check()).toEqual({ t: 'integrity_result', ok: true })
  })

  it('leaves an unchanged file alone', () => {
    const { check, notices } = setup()

    vi.advanceTimersByTime(TICK_MS * 3)

    expect(check()).toEqual({ t: 'integrity_result', ok: true })
    expect(notices()).toEqual([])
  })

  it('stops ticking once the broker closes', () => {
    const { settings, notices } = setup()
    servers.splice(0)[0]?.close()

    fs.rmSync(settings)
    vi.advanceTimersByTime(TICK_MS * 2)

    expect(notices()).toEqual([])
  })
})

describe('settings-watch edge cases', () => {
  it('keeps watching a change whose nonce the ledger does not know yet', () => {
    const { settings, notices, server } = setup()
    const late = 'd'.repeat(64)
    server.settingsWatch.register(late, settings)
    fs.writeFileSync(settings, JSON.stringify({ hooks: {} }))

    vi.advanceTimersByTime(TICK_MS)
    server.integrity.registerLaunch(late, 'a1', { [ZSHRC]: zshrc })
    vi.advanceTimersByTime(TICK_MS)

    expect(notices()).toHaveLength(2)
    expect(server.integrity.check(late, 's1', { [ZSHRC]: zshrc })).toMatchObject({ reason: 'quarantined' })
  })

  it('refuses a baseline for a file that is missing', () => {
    const { settings, server } = setup()
    fs.rmSync(settings)

    expect(() => server.settingsWatch.register('e'.repeat(64), settings)).toThrow(/unreadable/)
  })
})
