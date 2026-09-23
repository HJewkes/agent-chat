import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SyncBatch } from '@titan-design/matrix-bus'
import { MemoryQueueSource, type MirrorBus } from '@titan-design/queue-mirror'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startStatusWriter } from '../mirror/run.js'
import {
  describeMirror,
  readMirrorFacts,
  readStatus,
  STATUS_STALE_MS,
  StatusTracker,
  trackBus,
  trackSource,
  type MirrorFacts,
  type MirrorFiles,
  type MirrorStatus,
} from '../mirror/status.js'

const NOW = 1_790_000_000_000

const running = (over: Partial<MirrorStatus> = {}): MirrorStatus => ({
  pid: 4242,
  startedAt: NOW - 60_000,
  writtenAt: NOW - 2_000,
  lastSyncAt: NOW - 12_000,
  lastSourceEventAt: null,
  open: 3,
  lastError: null,
  ...over,
})

const facts = (over: Partial<MirrorFacts> = {}): MirrorFacts => ({
  configPresent: true,
  configPath: '/h/.agent-chat/mirror.json',
  envMode: 0o600,
  plistLeaksToken: false,
  status: running(),
  pidAlive: true,
  roomAlias: '#queue:example.org',
  now: NOW,
  ...over,
})

describe('describeMirror (the doctor line)', () => {
  it('reports a running mirror with its sync age and open count', () => {
    expect(describeMirror(facts())).toEqual({
      name: 'mirror',
      status: 'ok',
      detail: 'running pid 4242, synced 12s ago, 3 open on #queue:example.org',
    })
  })

  it('treats an absent config as a state, not a fault', () => {
    expect(describeMirror(facts({ configPresent: false }))).toMatchObject({
      status: 'warn',
      detail: 'not configured (/h/.agent-chat/mirror.json absent)',
    })
  })

  it('fails a readable env file before anything else', () => {
    expect(describeMirror(facts({ envMode: 0o644 }))).toMatchObject({
      status: 'fail',
      detail: 'mirror.env is 0644; must be 0600',
    })
  })

  it('fails a plist that carries the token', () => {
    expect(describeMirror(facts({ plistLeaksToken: true })).status).toBe('fail')
  })

  it('warns on a stale status file instead of calling it running', () => {
    const stale = running({ writtenAt: NOW - 4 * 60_000 })
    expect(describeMirror(facts({ status: stale }))).toMatchObject({
      status: 'warn',
      detail: 'status 4m stale',
    })
  })

  it('warns when the recorded pid is gone, with the last error it wrote', () => {
    const dead = running({ lastError: 'M_FORBIDDEN: not invited' })
    expect(describeMirror(facts({ status: dead, pidAlive: false }))).toMatchObject({
      status: 'warn',
      detail: 'configured but not running (last error: M_FORBIDDEN: not invited)',
    })
  })

  it('does not call a status just inside the window stale', () => {
    const edge = running({ writtenAt: NOW - STATUS_STALE_MS })
    expect(describeMirror(facts({ status: edge })).status).toBe('ok')
  })
})

describe('readMirrorFacts', () => {
  let dir: string
  let files: MirrorFiles

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mirror-facts-'))
    files = {
      config: path.join(dir, 'mirror.json'),
      env: path.join(dir, 'mirror.env'),
      plist: path.join(dir, 'job.plist'),
      status: path.join(dir, 'mirror.status.json'),
    }
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('finds the live token value in the plist even without the key name or prefix', () => {
    fs.writeFileSync(files.config, '{}')
    fs.writeFileSync(files.env, 'EDGE1_AS_TOKEN=as-opaque-9f8e\n', { mode: 0o600 })
    fs.writeFileSync(files.plist, '<string>as-opaque-9f8e</string>')
    expect(readMirrorFacts(files, NOW).plistLeaksToken).toBe(true)
  })

  it('reads a status file the writer produced', () => {
    const tracker = new StatusTracker(() => NOW)
    tracker.noteSync()
    const stop = startStatusWriter(tracker, () => 2, files.status)
    stop()
    expect(readStatus(files.status)).toMatchObject({ pid: process.pid, lastSyncAt: NOW, open: 2 })
    expect(fs.statSync(files.status).mode & 0o777).toBe(0o600)
    expect(readMirrorFacts(files, NOW)).toMatchObject({ configPresent: false, pidAlive: true, envMode: null })
  })
})

describe('trackSource and trackBus', () => {
  it('stamp each tailed event and each sync batch on the tracker', async () => {
    let clock = 100
    const tracker = new StatusTracker(() => clock)
    const source = new MemoryQueueSource()
    const controller = new AbortController()
    const events = trackSource(source, tracker).tail(undefined, controller.signal)[Symbol.asyncIterator]()
    source.add({ id: 'q1', kind: 'question', machine: 'edge1', session: 'a', at: 1, text: 'hi' })
    clock = 200
    await events.next()

    const batch: SyncBatch = { since: 's1', events: [] }
    const bus: MirrorBus = {
      userId: '@m:x',
      send: async () => ({ event_id: '$1' }),
      async *syncLoop() {
        yield batch
      },
    }
    clock = 300
    for await (const _ of trackBus(bus, tracker).syncLoop()) break
    controller.abort()

    expect(tracker.snapshot(0)).toMatchObject({ lastSourceEventAt: 200, lastSyncAt: 300 })
  })
})
