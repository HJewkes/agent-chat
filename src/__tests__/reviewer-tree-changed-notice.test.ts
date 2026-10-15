import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { REVIEWER_TREE_CHANGED } from '../agents/reviewer-tree-guard.js'
import type { DeliveredMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-233: a reviewer that exits having changed the tree it reviewed is reported to its spawner.
 * The reviewer is a controlled headless child; the test makes its edit, then fires its exit.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let delivered: { conn: Conn; message: DeliveredMessage }[]
let stopAutoAttach: () => void
let exitChild: (code: number) => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })

/** An implementer's linked worktree, which is where a reviewer runs. */
function implementerTree(): string {
  const repo = tmp('agent-chat-rtc-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'constants.ts'), 'export const ATWATER = 4\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'seed')
  const tree = path.join(tmp('agent-chat-rtc-trees-'), 'impl')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', tree)
  return tree
}

const controlledChild = () => ({
  pid: 4242,
  unref: () => undefined,
  once: (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'exit') exitChild = code => listener(code, null)
  },
})

function writeProfile(home: string, name: string): void {
  const profile = {
    description: name,
    model: 'sonnet',
    allowedTools: ['Read', 'Bash'],
    disallowedTools: ['Write', 'Edit'],
    isolation: 'none',
    surface: 'headless',
  }
  fs.writeFileSync(path.join(home, 'profiles', `${name}.json`), JSON.stringify(profile))
}

beforeEach(() => {
  const home = tmp('agent-chat-rtc-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'))
  writeProfile(home, 'bd-reviewer')
  writeProfile(home, 'bd-implementer')
  delivered = []
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore((conn, message) => delivered.push({ conn, message }), {
    events,
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, {
    cwdLister: async () => [],
    surface: { platform: 'linux', spawn: controlledChild },
  })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function registerCoord(): net.Socket {
  const coord = {} as unknown as net.Socket
  core.register(coord, { t: 'register', name: 'coord', workingOn: '', cwd: tmp('agent-chat-coord-'), pid: 1 })
  return coord
}

async function spawnIn(cwd: string, profile: string, name: string): Promise<void> {
  const result = await supervisor.spawn({
    name,
    profile,
    brief: 'review the change',
    requestedBy: 'coord',
    cwd,
    isolation: 'none',
    surface: 'headless',
    spawnerConfigDir: tmp('agent-chat-rtc-account-'),
  })
  expect(result.reason).toBeUndefined()
  await vi.waitFor(() => expect(core.agents.get(result.agentId as string)?.state).toBe('live'))
}

const treeNotices = () => core.events.history(200).filter(row => row.meta.event === REVIEWER_TREE_CHANGED)
const unreported = () => core.events.history(200).filter(row => row.meta.event === 'unreported-exit')

/** The unreported-exit notice is sent after the tree check, so its arrival means the exit is fully handled. */
async function exitAndSettle(): Promise<void> {
  exitChild(0)
  await vi.waitFor(() => expect(unreported()).toHaveLength(1))
}

describe('a reviewer that exits having changed the reviewed tree', () => {
  it('tells its spawner which paths changed', async () => {
    const coord = registerCoord()
    const tree = implementerTree()
    await spawnIn(tree, 'bd-reviewer', 'rv-review-1')
    fs.writeFileSync(path.join(tree, 'constants.ts'), 'export const ATWATER = 9\n')

    await exitAndSettle()

    const [row] = treeNotices()
    expect(row?.meta).toMatchObject({
      target: 'coord',
      agent: 'rv-review-1',
      cwd: tree,
      paths: 'constants.ts',
    })
    expect(row?.text).toContain('constants.ts')
    const pushed = delivered.find(d => d.message.event === REVIEWER_TREE_CHANGED)
    expect(pushed?.conn).toBe(coord)
  })

  it('sends nothing when the tree is as it was', async () => {
    registerCoord()
    await spawnIn(implementerTree(), 'bd-reviewer', 'rv-review-1')

    await exitAndSettle()

    expect(treeNotices()).toEqual([])
  })

  it('sends nothing for a non-reviewer that edits its tree', async () => {
    registerCoord()
    const tree = implementerTree()
    await spawnIn(tree, 'bd-implementer', 'impl-1')
    fs.writeFileSync(path.join(tree, 'constants.ts'), 'export const ATWATER = 9\n')

    await exitAndSettle()

    expect(treeNotices()).toEqual([])
  })
})
