import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { HUMAN_ROOT } from '../broker/integrity-ledger.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { FileRecord, Records } from '../leak-guard/integrity/record.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/** TP-4256 A2: the `integrity_check` frame over the broker's ledger. Names, ids and paths are synthetic. */

const NONCE = 'b'.repeat(64)
const ZSHRC = '/home/example/.zshrc'
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const zshrc = (sha256: string): FileRecord => ({
  kind: 'startup',
  state: 'present',
  lstat: { dev: '1', ino: '5', size: '3', ctimeNs: '50' },
  sha256,
})

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integrity-frame-'))
  tmpDirs.push(dir)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  core.append({ kind: 'agent_spawned', actor: 'coord', target: 'scout', msgId: 'a1', body: 'work' })
  const server = new SocketServer(core)
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  const send = (nonce: string, records: Records): ServerMessage | undefined => {
    server.handleMessage(conn, { t: 'integrity_check', nonce, session: 's1', records } as ClientMessage)
    return frames.at(-1)
  }
  const notices = () => core.events.since(0, 500).filter(row => row.kind === 'notice')
  const admit = (): string => {
    const settings = path.join(dir, 'settings.json')
    fs.writeFileSync(settings, '{}')
    const startup = { [ZSHRC]: zshrc('h1') }
    return server.integrity.admit({ agentId: 'a1', parent: HUMAN_ROOT }, () => ({
      startup,
      files: [settings],
    })).nonce
  }
  return { send, notices, admit }
}

describe('integrity_check frame', () => {
  it('denies an unknown nonce and files no notice', () => {
    const { send, notices } = setup()

    const result = send(NONCE, { [ZSHRC]: zshrc('h1') })

    expect(result).toEqual({ t: 'integrity_result', ok: false, reason: 'no baseline' })
    expect(notices()).toEqual([])
  })

  it('files one notice per agent however many checks deny after a mismatch', () => {
    const { send, notices, admit } = setup()
    const nonce = admit()

    const first = send(nonce, { [ZSHRC]: zshrc('h2') })
    const clean = send(nonce, { [ZSHRC]: zshrc('h1') })
    send(nonce, { [ZSHRC]: zshrc('h3') })

    expect(first).toEqual({
      t: 'integrity_result',
      ok: false,
      reason: 'changed',
      file: ZSHRC,
      field: 'sha256',
    })
    expect(clean).toMatchObject({ ok: false, reason: 'quarantined', file: ZSHRC })
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toMatchObject({ actor: 'agent-chat', target: 'human', meta: { agent: 'scout' } })
  })

  it('denies malformed records without latching the nonce', () => {
    const { send, admit } = setup()
    const nonce = admit()

    const malformed = send(nonce, { [ZSHRC]: { kind: 'startup', state: 'present' } } as unknown as Records)
    const clean = send(nonce, { [ZSHRC]: zshrc('h1') })

    expect(malformed).toMatchObject({ ok: false, reason: expect.stringContaining('records') })
    expect(clean).toEqual({ t: 'integrity_result', ok: true })
  })
})
