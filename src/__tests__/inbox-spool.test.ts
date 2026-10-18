import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { channelDelivery, type ChannelParams } from '../server/index.js'
import { resolveInboxSpool, type SpoolFs } from '../server/inbox-spool.js'
import type { DeliveredMessage } from '../protocol.js'

/**
 * CC-1455 S2: a print-mode host's MCP server spools every push for a hook to
 * drain. Each test names the mutation it catches. Every name and id is synthetic.
 */

const PRINT_ARGV = 'claude -p --output-format stream-json --verbose --channels plugin:agent-chat@local'
const INTERACTIVE_ARGV = 'claude --channels plugin:agent-chat@local'
const SPOOL_ENV = { AGENT_CHAT_INBOX_SPOOL: '1' }

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const spoolDir = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-spool-'))
  tmpDirs.push(root)
  return path.join(root, 'inbox')
}

const message = (msgId: string, text: string, extra: Partial<DeliveredMessage> = {}): DeliveredMessage =>
  ({ msgId, from: 'scout', text, ...extra }) as DeliveredMessage

const records = (dir: string): Array<Record<string, unknown>> =>
  fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>)

/** Delivery wired the way `startMcpServer` wires it, for a host whose argv is `argv`. */
const deliveryFor = (argv: string, notes: ChannelParams[], deps = {}) => {
  const dir = resolveInboxSpool({ agentId: 'agent-x', env: SPOOL_ENV, hostPid: 4242, read: () => argv })
  return {
    dir,
    ...channelDelivery(
      params => notes.push(params),
      () => undefined,
      dir,
      deps,
    ),
  }
}

describe('resolveInboxSpool', () => {
  it('spools under the agent dir for a print host whose launch opted in', () => {
    // Arrange
    const read = () => PRINT_ARGV

    // Act
    const dir = resolveInboxSpool({ agentId: 'agent-x', env: SPOOL_ENV, hostPid: 4242, read })

    // Assert
    expect(dir?.endsWith(path.join('agents', 'agent-x', 'inbox'))).toBe(true)
  })

  it('does not spool when the launch did not opt in, so the slice ships dark', () => {
    // Act
    const dir = resolveInboxSpool({ agentId: 'agent-x', env: {}, hostPid: 4242, read: () => PRINT_ARGV })

    // Assert
    expect(dir).toBeUndefined()
  })
})

describe('channelDelivery with a spool', () => {
  it('leaves two records in arrival order holding msgId, from, the meta attributes and the text', () => {
    // Arrange: a fixed clock, and ids whose own sort order is the reverse of arrival.
    // Catches: dropping the seq from the file name, which sorts by msgId instead.
    const dir = spoolDir()
    const notes: ChannelParams[] = []
    const { deliver } = channelDelivery(
      n => notes.push(n),
      () => undefined,
      dir,
      { now: () => 1_000 },
    )

    // Act
    deliver(message('msg-b', 'STAND DOWN', { provenance: 'human-endorsed', inReplyTo: 'msg-0' }))
    deliver(message('msg-a', 'second', { broadcast: true }))

    // Assert
    const [first, second] = records(dir)
    expect(first).toMatchObject({ kind: 'message', msgId: 'msg-b', text: 'STAND DOWN' })
    expect(first!.meta).toEqual({
      from: 'scout',
      msg_id: 'msg-b',
      in_reply_to: 'msg-0',
      provenance: 'human-endorsed',
    })
    expect(second).toMatchObject({ msgId: 'msg-a', meta: { from: 'scout', broadcast: 'true' } })
    expect(notes).toHaveLength(2)
  })

  it('never shows a partial .json: each record appears only by rename, with 0700/0600 modes', () => {
    // Arrange: an fs that looks at the dir right after each write, before the rename.
    // Catches: writing the final name directly instead of renaming a temp file.
    const dir = spoolDir()
    const seenAtWrite: string[][] = []
    const watching: SpoolFs = {
      mkdirSync: fs.mkdirSync,
      renameSync: fs.renameSync,
      writeFileSync: ((file, data, options) => {
        fs.writeFileSync(file, data, options)
        seenAtWrite.push(fs.readdirSync(dir).filter(name => name.endsWith('.json')))
      }) as SpoolFs['writeFileSync'],
    }
    const { deliver } = channelDelivery(
      () => undefined,
      () => undefined,
      dir,
      { fs: watching },
    )

    // Act
    deliver(message('msg-1', 'one'))
    deliver(message('msg-2', 'two'))

    // Assert
    expect(seenAtWrite.map(names => names.length)).toEqual([0, 1])
    const [file] = fs.readdirSync(dir)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dir, file!)).mode & 0o777).toBe(0o600)
  })

  it('keeps a batch frame’s senders and msg_ids', () => {
    // Arrange
    const dir = spoolDir()
    const { deliver } = channelDelivery(
      () => undefined,
      () => undefined,
      dir,
    )
    const batch = [
      { from: 'scout', msgId: 'msg-1' },
      { from: 'seat-x', msgId: 'msg-2' },
    ] as DeliveredMessage['batch']

    // Act
    deliver(message('batch-1', 'two reports', { from: 'agent-chat', batch }))

    // Assert
    expect(records(dir)[0]!.meta).toMatchObject({
      count: '2',
      senders: 'scout,seat-x',
      msg_ids: 'msg-1,msg-2',
    })
  })

  it('spools a lifecycle frame as one system record with no msgId', () => {
    // Arrange
    const dir = spoolDir()
    const { deliverSystemEvents } = channelDelivery(
      () => undefined,
      () => undefined,
      dir,
    )

    // Act
    deliverSystemEvents([{ subject: 'scout', kind: 'agent_exited' }] as Parameters<
      typeof deliverSystemEvents
    >[0])

    // Assert
    const [record] = records(dir)
    expect(record).toEqual({
      kind: 'system',
      meta: { from: 'agent-chat', system: 'true', count: '1' },
      text: 'Lifecycle: scout agent_exited',
    })
  })
})

describe('the print gate', () => {
  it('spools nothing for an interactive host and still sends the push', () => {
    // Arrange: the agent dir would be under a home nobody created, so any write would show up.
    // Catches: removing the print gate.
    const notes: ChannelParams[] = []
    const { dir, deliver } = deliveryFor(INTERACTIVE_ARGV, notes)

    // Act
    deliver(message('msg-1', 'hello'))

    // Assert
    expect(dir).toBeUndefined()
    expect(notes).toEqual([{ content: 'hello', meta: { from: 'scout', msg_id: 'msg-1' } }])
  })

  it('spools for a print host and still sends the push', () => {
    // Arrange: redirect the would-be agent dir writes into a temp dir.
    const target = spoolDir()
    const notes: ChannelParams[] = []
    const redirect: SpoolFs = {
      mkdirSync: (_p, o) => fs.mkdirSync(target, o),
      writeFileSync: ((p, d, o) =>
        fs.writeFileSync(path.join(target, path.basename(String(p))), d, o)) as SpoolFs['writeFileSync'],
      renameSync: (from, to) =>
        fs.renameSync(
          path.join(target, path.basename(String(from))),
          path.join(target, path.basename(String(to))),
        ),
    }
    const { dir, deliver } = deliveryFor(PRINT_ARGV, notes, { fs: redirect })

    // Act
    deliver(message('msg-1', 'hello'))

    // Assert
    expect(dir).toBeDefined()
    expect(records(target)).toHaveLength(1)
    expect(notes).toHaveLength(1)
  })
})
