import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1253: a parked tree that `agent resume` re-creates comes back with the
 * dependencies its repository's declared lockfile install provides (CC-313),
 * before the resumed agent's turn, for both an npm and a pnpm repository.
 */

type Manager = 'npm' | 'pnpm'

const hasPnpm = spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status === 0
const INSTALL_TIMEOUT_MS = 60_000

const tmpDirs: string[] = []
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void
let savedStoreDir: string | undefined

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const run = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const git = (args: string[], cwd: string): string => run('git', args, cwd)

const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const INSTALL: Record<Manager, { spec: string; lock: string[]; setup: string[] }> = {
  npm: {
    spec: 'file:./vendor/local-dep',
    lock: ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    setup: ['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
  },
  pnpm: {
    spec: 'link:./vendor/local-dep',
    lock: ['install', '--lockfile-only', '--offline', '--ignore-scripts'],
    setup: ['pnpm', 'install', '--offline', '--frozen-lockfile'],
  },
}

function seedRepo(): string {
  const dir = tmp('deps-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  return dir
}

/** A repository whose origin declares a lockfile install of one vendored dependency. */
function repoDeclaring(manager: Manager): string {
  const repo = seedRepo()
  const install = INSTALL[manager]
  writeJson(path.join(repo, 'vendor/local-dep/package.json'), { name: 'local-dep', version: '1.0.0' })
  writeJson(path.join(repo, 'package.json'), {
    name: 'deps-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { 'local-dep': install.spec },
  })
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
  run(manager, install.lock, repo)
  writeJson(path.join(repo, '.agent-chat/worktree.json'), {
    setup: { command: install.setup, timeoutMs: INSTALL_TIMEOUT_MS },
  })
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'seed'], repo)
  const origin = tmp('deps-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  return repo
}

async function spawnIn(name: string, repo: string): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile: 'explorer',
    brief: 'do the task',
    requestedBy: 'human',
    cwd: repo,
    isolation: 'worktree',
    surface: 'headless',
    spawnerConfigDir: tmp('deps-account-'),
  })
  expect(spawned.reason).toBeUndefined()
  const agent = core.agents.get(spawned.agentId as string)!
  const transcript = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, '{}\n')
  return agent
}

async function exit(agent: AgentIdentity): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

/** Spawn, commit, push and exit an agent, then park its tree and check the dependencies went with it. */
async function parkedAgent(repo: string): Promise<AgentIdentity> {
  const agent = await spawnIn('worker-a', repo)
  fs.writeFileSync(path.join(agent.cwd, 'feature.ts'), 'work\n')
  git(['add', 'feature.ts'], agent.cwd)
  git(['commit', '-q', '-m', 'add feature.ts'], agent.cwd)
  git(['push', '-q', 'origin', 'agent-chat/worker-a'], agent.cwd)
  await exit(agent)
  expect(await sup.park('worker-a')).toMatchObject({ ok: true })
  expect(fs.existsSync(path.join(agent.cwd, 'node_modules'))).toBe(false)
  return agent
}

const setupWarnings = (warnings: string[] | undefined): string[] =>
  (warnings ?? []).filter(w => w.includes('worktree setup'))

beforeEach(() => {
  const home = tmp('deps-home-')
  process.env.AGENT_CHAT_HOME = home
  savedStoreDir = process.env.npm_config_store_dir
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    cwdLister: async () => [],
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  if (savedStoreDir === undefined) delete process.env.npm_config_store_dir
  else process.env.npm_config_store_dir = savedStoreDir
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('resuming a parked agent whose repository declares a lockfile install', () => {
  it(
    'a parked npm tree comes back from resume with node_modules installed',
    async () => {
      const agent = await parkedAgent(repoDeclaring('npm'))

      const resumed = await sup.resume('worker-a')

      expect(resumed.reason).toBeUndefined()
      expect(setupWarnings(resumed.warnings)).toEqual([])
      expect(fs.existsSync(path.join(agent.cwd, 'node_modules/local-dep/package.json'))).toBe(true)
    },
    INSTALL_TIMEOUT_MS,
  )

  it.skipIf(!hasPnpm)(
    'a parked pnpm tree comes back from resume with node_modules installed',
    async () => {
      process.env.npm_config_store_dir = tmp('deps-pnpm-store-')
      const agent = await parkedAgent(repoDeclaring('pnpm'))

      const resumed = await sup.resume('worker-a')

      expect(resumed.reason).toBeUndefined()
      expect(setupWarnings(resumed.warnings)).toEqual([])
      expect(fs.existsSync(path.join(agent.cwd, 'node_modules/local-dep/package.json'))).toBe(true)
      expect(fs.existsSync(path.join(agent.cwd, 'node_modules/.modules.yaml'))).toBe(true)
    },
    INSTALL_TIMEOUT_MS,
  )
})
