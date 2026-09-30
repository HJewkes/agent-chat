import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../agents/burndown/exec.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { seatLogPath } from '../agents/seats/io.js'
import type { Conn } from '../broker/core.js'
import { openServices } from '../broker/daemon.js'
import { burndownLedgerPath } from '../paths.js'
import type { ServerMessage } from '../protocol.js'

/**
 * CC-316: the broker and the burndown tick each hand the seat journal to the code
 * that writes its lines. Every seat, prefix, task id and repository here is
 * synthetic, and the home and the active-work root are temp directories.
 */

const SEAT = 'seat-x'
const NOW = new Date(2026, 1, 3, 4, 5)
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'
const PR = 'https://github.com/example-org/widget/pull/7'

let world: string
let autonomy: string

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const journal = (): string | undefined => {
  const file = seatLogPath(autonomy, SEAT, NOW)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-journal-wiring-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  fs.mkdirSync(path.join(world, 'home'), { recursive: true })
  autonomy = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  write(path.join(autonomy, 'seats', `${SEAT}.md`), '---\nprefix: sx\npool: pool-a\n---\n')
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  fs.rmSync(world, { recursive: true, force: true })
})

describe('the burndown tick', () => {
  const merging: Claim = {
    taskId: 'AB-12',
    initiative: 'demo',
    seat: SEAT,
    namePrefix: 'sx',
    spawnedAt: NOW.toISOString(),
    phase: 'awaiting-merge',
    phaseAt: NOW.toISOString(),
    agentName: 'sx-ab-12',
    spawned: ['sx-ab-12'],
    pr: PR,
    notified: ['dispatched', 'ready-to-merge'],
  }

  const broker: TickBroker = {
    roster: async () => ({ agents: [], slots: { held: 0, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async frame => ({ ok: true, agentId: `id-${frame.name}` }),
    retire: async () => ({ ok: true }),
    queue: async () => [],
    resume: async name => ({ ok: true, agentId: `id-${name}` }),
    collisionView: async () => ({ names: [], claims: [] }),
    seatSender: async () => ({
      send: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
      close: () => undefined,
    }),
  }

  /** `gh pr view` answers only the fields its `--json` names, as the real one does. */
  const gh: Runner = (_bin, args) => {
    const merged: Record<string, unknown> = { state: 'MERGED', statusCheckRollup: [], headRefOid: HEAD }
    const asked = args[0] === 'pr' ? (args[args.indexOf('--json') + 1] ?? '').split(',') : []
    return {
      status: 0,
      stdout: JSON.stringify(Object.fromEntries(asked.map(f => [f, merged[f]]))),
      stderr: '',
    }
  }

  it('writes the merged line, with the PR head it read, to the journal under the active-work root', async () => {
    const config = { enabled: true, reportTo: 'coord', seats: [SEAT] }
    write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
    writeLedger(burndownLedgerPath(), { version: 1, claims: [merging] })

    await tickFromDisk({ dryRun: false, broker, now: NOW, log: () => {}, exec: gh })

    expect(readLedger(burndownLedgerPath()).claims[0]).toMatchObject({ phase: 'done', prHead: HEAD })
    expect(journal()).toBe('04:05 merged AB-12 sx-ab-12 example-org/widget#7@abcdef1\n')
  })
})

describe('the broker’s services', () => {
  const retireOver = async (ephemeral: boolean): Promise<ServerMessage> => {
    const { core, socketServer } = openServices(ephemeral)
    try {
      core.append({
        kind: 'agent_spawned',
        actor: 'human',
        target: 'sx-ab-12-fix',
        msgId: 'a1',
        body: 'work',
      })
      const frames: ServerMessage[] = []
      const conn = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn
      socketServer.handleMessage(conn, { t: 'retire', name: 'sx-ab-12-fix' })
      await expect.poll(() => frames.length).toBe(1)
      return frames[0] as ServerMessage
    } finally {
      socketServer.close()
      core.close()
    }
  }

  it('write a retire line for a seat’s agent when the home is a lasting one', async () => {
    const reply = await retireOver(false)

    const days = fs.readdirSync(path.join(autonomy, 'logs', SEAT))
    const written = fs.readFileSync(path.join(autonomy, 'logs', SEAT, days[0] ?? ''), 'utf8')
    expect(reply).toMatchObject({ t: 'spawn_result', ok: true })
    expect(days).toHaveLength(1)
    expect(written).toMatch(/^\d\d:\d\d retire AB-12 sx-ab-12-fix -\n$/)
  })

  it('write nothing when the home is a test’s', async () => {
    const reply = await retireOver(true)

    expect(reply).toMatchObject({ t: 'spawn_result', ok: true })
    expect(fs.existsSync(path.join(autonomy, 'logs'))).toBe(false)
  })
})
